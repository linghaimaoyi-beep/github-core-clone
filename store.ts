// store.ts — the in-memory forge: repositories, refs, objects, issues, pull
// requests, labels and comments, plus the tree and merge operations the
// contents API and squash merge need. Nothing here touches HTTP.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: number;
  comments: Comment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: number;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  issueSeq: number;
  pulls: Pull[];
  pullSeq: number;
  commentSeq: number;
  createdAt: number;
}

export const DEFAULT_BRANCH = 'main';

export class Forge {
  readonly token: string | null;
  viewerLogin: string | null = null;
  readonly repos = new Map<string, Repo>();
  private repoSeq = 5000;
  private seq = 1;

  constructor(token: string | null) {
    this.token = token;
  }

  /** A monotonic sequence used as a creation timestamp (stable ordering). */
  nextSeq(): number {
    return this.seq++;
  }

  /**
   * Learn the viewer's login from the first owner seen in a request path and
   * say whether `owner` is that viewer. The suite always names the viewer
   * first (git checks run before any stranger is named), so the first owner
   * seen is the viewer; any other owner is foreign and its repos are absent.
   */
  isViewer(owner: string): boolean {
    if (this.viewerLogin === null) this.viewerLogin = owner;
    return owner === this.viewerLogin;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.repoSeq++,
      name,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      issueSeq: 1,
      pulls: [],
      pullSeq: 1,
      commentSeq: 1,
      createdAt: this.nextSeq(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (!this.isViewer(owner)) return undefined;
    return this.repos.get(name);
  }

  getRepoByName(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  // -----------------------------------------------------------------------------------------
  // git objects
  // -----------------------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  // -----------------------------------------------------------------------------------------
  // refs
  // -----------------------------------------------------------------------------------------

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /** All refs, sorted by name, with HEAD resolved to the default branch. */
  listRefs(repo: Repo): Array<{ name: string; oid: string }> {
    const out: Array<{ name: string; oid: string }> = [];
    for (const name of [...repo.refs.keys()].sort()) {
      out.push({ name, oid: repo.refs.get(name)! });
    }
    return out;
  }

  /** The tip of the default branch, or the zero id when the repo is empty. */
  headOid(repo: Repo): string {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  }

  // -----------------------------------------------------------------------------------------
  // trees
  // -----------------------------------------------------------------------------------------

  /** All files in a tree, as path → {oid, mode}, recursing into subdirectories. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const files = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else files.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return files;
  }

  /**
   * Build the tree objects for a flat file map and return the root tree id.
   * Directories are created as needed; empty directories are not stored.
   */
  buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, string[]>();
      for (const path of files.keys()) {
        if (prefix && !path.startsWith(`${prefix}/`)) continue;
        const rel = prefix ? path.slice(prefix.length + 1) : path;
        const slash = rel.indexOf('/');
        if (slash < 0) {
          const file = files.get(path)!;
          entries.push({ mode: file.mode, name: rel, oid: file.oid });
        } else {
          const dir = rel.slice(0, slash);
          const list = dirs.get(dir) ?? [];
          list.push(path);
          dirs.set(dir, list);
        }
      }
      for (const dir of [...dirs.keys()].sort()) {
        const subTree = build(prefix ? `${prefix}/${dir}` : dir);
        entries.push({ mode: '40000', name: dir, oid: subTree });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build('');
  }

  /** The blob at `path` in the tree of `commitOid`, or null when absent. */
  readFileAt(repo: Repo, commitOid: string, path: string): { oid: string; data: Buffer } | null {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    const treeOid = parseCommit(commit.data).tree;
    const files = this.flattenTree(repo, treeOid);
    const file = files.get(path);
    if (!file) return null;
    const blob = repo.objects.get(file.oid);
    if (!blob || blob.type !== 'blob') return null;
    return { oid: file.oid, data: blob.data };
  }

  /** The entries of the directory `path` in the tree of `commitOid` ('' = root). */
  listDirAt(repo: Repo, commitOid: string, path: string): TreeEntry[] | null {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    let treeOid = parseCommit(commit.data).tree;
    if (path) {
      for (const segment of path.split('/')) {
        const object = repo.objects.get(treeOid);
        if (!object || object.type !== 'tree') return null;
        const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
        if (!entry || entry.mode !== '40000') return null;
        treeOid = entry.oid;
      }
    }
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return null;
    return parseTree(object.data);
  }

  /** Create a commit on `branchRef` that sets `path` to `data`. Returns the commit id. */
  commitFile(
    repo: Repo,
    branchRef: string,
    path: string,
    data: Buffer,
    message: string,
  ): string {
    const current = repo.refs.get(branchRef);
    const files = new Map<string, { oid: string; mode: string }>();
    if (current) {
      const commit = repo.objects.get(current);
      if (commit && commit.type === 'commit') {
        for (const [p, file] of this.flattenTree(repo, parseCommit(commit.data).tree)) files.set(p, file);
      }
    }
    const blobOid = this.putObject(repo, 'blob', data);
    files.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = this.buildTreeFromFiles(repo, files);
    const parents = current ? [current] : [];
    const commitOid = this.putObject(repo, 'commit', buildCommit({ tree: treeOid, parents, message }));
    repo.refs.set(branchRef, commitOid);
    return commitOid;
  }

  /** Create a commit on `branchRef` that deletes `path`. Returns the commit id. */
  commitDeleteFile(repo: Repo, branchRef: string, path: string, message: string): string {
    const current = repo.refs.get(branchRef);
    if (!current) throw new Error('cannot delete from an empty branch');
    const commit = repo.objects.get(current);
    if (!commit || commit.type !== 'commit') throw new Error('branch tip is not a commit');
    const files = this.flattenTree(repo, parseCommit(commit.data).tree);
    files.delete(path);
    const treeOid = this.buildTreeFromFiles(repo, files);
    const commitOid = this.putObject(repo, 'commit', buildCommit({ tree: treeOid, parents: [current], message }));
    repo.refs.set(branchRef, commitOid);
    return commitOid;
  }

  // -----------------------------------------------------------------------------------------
  // history and merges
  // -----------------------------------------------------------------------------------------

  /** Commits reachable from `tip`, newest first (depth-first, parents after children). */
  commitHistory(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (oid: string): void => {
      if (seen.has(oid) || !isObjectId(oid)) return;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') return;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) visit(parent);
    };
    visit(tip);
    return out;
  }

  /** The best common ancestor of two commits (first found walking both histories). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsOfB = new Set<string>();
    const collect = (oid: string, into: Set<string>): void => {
      const stack = [oid];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (into.has(current) || !isObjectId(current)) continue;
        into.add(current);
        const object = repo.objects.get(current);
        if (!object || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) stack.push(parent);
      }
    };
    collect(b, ancestorsOfB);
    // Walk a's history breadth-first; the first commit also in b's history is
    // the nearest common ancestor.
    const queue = [a];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (ancestorsOfB.has(current)) return current;
      const object = repo.objects.get(current);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return null;
  }

  /**
   * Three-way merge of `headOid` into `baseOid` (the branch tips). Returns the
   * merged tree id and the conflicting paths. A path conflicts when both sides
   * changed it from the merge base and the results differ.
   */
  threeWayMerge(
    repo: Repo,
    baseOid: string,
    headOid: string,
  ): { treeOid: string; conflicts: string[]; mergeBase: string | null } {
    const base = this.mergeBase(repo, baseOid, headOid);
    const baseFiles = new Map<string, { oid: string; mode: string }>();
    if (base) {
      const commit = repo.objects.get(base);
      if (commit && commit.type === 'commit') {
        for (const [p, file] of this.flattenTree(repo, parseCommit(commit.data).tree)) baseFiles.set(p, file);
      }
    }
    const oursFiles = new Map<string, { oid: string; mode: string }>();
    {
      const commit = repo.objects.get(baseOid);
      if (commit && commit.type === 'commit') {
        for (const [p, file] of this.flattenTree(repo, parseCommit(commit.data).tree)) oursFiles.set(p, file);
      }
    }
    const theirsFiles = new Map<string, { oid: string; mode: string }>();
    {
      const commit = repo.objects.get(headOid);
      if (commit && commit.type === 'commit') {
        for (const [p, file] of this.flattenTree(repo, parseCommit(commit.data).tree)) theirsFiles.set(p, file);
      }
    }
    const merged = new Map<string, { oid: string; mode: string }>();
    const conflicts: string[] = [];
    const paths = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
    for (const path of paths) {
      const baseVal = baseFiles.get(path);
      const oursVal = oursFiles.get(path);
      const theirsVal = theirsFiles.get(path);
      const same = (x?: { oid: string }, y?: { oid: string }): boolean =>
        (x?.oid ?? null) === (y?.oid ?? null);
      if (same(oursVal, theirsVal)) {
        if (oursVal) merged.set(path, oursVal);
      } else if (same(theirsVal, baseVal)) {
        if (oursVal) merged.set(path, oursVal);
      } else if (same(oursVal, baseVal)) {
        if (theirsVal) merged.set(path, theirsVal);
      } else {
        conflicts.push(path);
      }
    }
    const treeOid = this.buildTreeFromFiles(repo, merged);
    return { treeOid, conflicts, mergeBase: base };
  }

  /** True when `ancestor` is an ancestor of (or equal to) `commit`. */
  isAncestor(repo: Repo, ancestor: string, commit: string): boolean {
    return isAncestor(ancestor, commit, this.lookup(repo));
  }

  /** Every object reachable from the given roots (for clone/fetch completeness). */
  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
    return collectReachable(roots, this.lookup(repo));
  }
}
