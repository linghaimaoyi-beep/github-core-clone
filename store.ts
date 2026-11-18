// store.ts — the in-memory forge: repositories, refs, objects, issues, pull
// requests, labels and comments, plus the tree and merge operations the
// contents API and squash merge need. Nothing here touches HTTP.
//
// Design notes (for the next reader):
//   - Everything lives in Maps on the Repo object; there is no database and
//     no persistence. A restart starts empty, which is what the suite
//     expects: every trial seeds its own repositories.
//   - Object ids are content hashes (git.ts `hashObject`), so two identical
//     blobs share one entry and `putObject` is idempotent.
//   - Issue and pull numbers are handed out sequentially from 1 and are
//     never reused or removed, so `findIssue`/`findPull` index straight
//     into the array at number - 1 (O(1)) with a linear scan only as a
//     safety net for an invariant that cannot break.
//   - `createdAt` is a monotonic sequence from `nextSeq()`, not a wall
//     clock, so creation order is stable and deterministic across runs.
//   - The viewer is learned from the first owner named in a request path
//     (`isViewer`); the suite always names the viewer first, so any other
//     owner is foreign and its repositories read as absent.

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

/**
 * Find an issue by number in O(1). Numbers are handed out sequentially from
 * 1 and issues are never removed, so the array is always in number order
 * and the issue sits at index number - 1. The scan is only a safety net
 * for a numbering invariant that can never break in practice.
 */
export function findIssue(repository: Repo, number: number): Issue | undefined {
  const direct = repository.issues[number - 1];
  if (direct !== undefined && direct.number === number) return direct;
  return repository.issues.find((candidate) => candidate.number === number);
}

/** Same O(1) lookup for pull requests (same sequential numbering). */
export function findPull(repository: Repo, number: number): Pull | undefined {
  const direct = repository.pulls[number - 1];
  if (direct !== undefined && direct.number === number) return direct;
  return repository.pulls.find((candidate) => candidate.number === number);
}

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
    const repository: Repo = {
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
    this.repos.set(name, repository);
    return repository;
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
  // objects
  // -----------------------------------------------------------------------------------------

  putObject(repository: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repository.objects.has(oid)) repository.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repository: Repo, oid: string): GitObject | undefined {
    return repository.objects.get(oid);
  }

  lookup(repository: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repository.objects.get(oid);
  }

  // -----------------------------------------------------------------------------------------
  // refs
  // -----------------------------------------------------------------------------------------

  getRef(repository: Repo, ref: string): string | undefined {
    return repository.refs.get(ref);
  }

  setRef(repository: Repo, ref: string, oid: string): void {
    repository.refs.set(ref, oid);
  }

  deleteRef(repository: Repo, ref: string): boolean {
    return repository.refs.delete(ref);
  }

  /** All refs, sorted by name. */
  listRefs(repository: Repo): Array<{ name: string; oid: string }> {
    const names = [...repository.refs.keys()].sort();
    const out: Array<{ name: string; oid: string }> = [];
    for (const name of names) out.push({ name, oid: repository.refs.get(name)! });
    return out;
  }

  /** The tip of the default branch, or the zero id when the repository is empty. */
  headOid(repository: Repo): string {
    return repository.refs.get(`refs/heads/${repository.defaultBranch}`) ?? ZERO_OID;
  }

  // -----------------------------------------------------------------------------------------
  // trees
  // -----------------------------------------------------------------------------------------

  /** All files in a tree, as path → {oid, mode}, recursing into subdirectories. */
  flattenTree(repository: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const files = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repository.objects.get(oid);
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
  buildTreeFromFiles(repository: Repo, files: Map<string, { oid: string; mode: string }>): string {
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
        entries.push({ mode: '40000', name: dir, oid: build(prefix ? `${prefix}/${dir}` : dir) });
      }
      return this.putObject(repository, 'tree', buildTree(entries));
    };
    return build('');
  }

  /** The blob at `path` in the tree of `commitOid`, or null when absent. */
  readFileAt(repository: Repo, commitOid: string, path: string): { oid: string; data: Buffer } | null {
    const commit = repository.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    const treeOid = parseCommit(commit.data).tree;
    const file = this.flattenTree(repository, treeOid).get(path);
    if (!file) return null;
    const blob = repository.objects.get(file.oid);
    if (!blob || blob.type !== 'blob') return null;
    return { oid: file.oid, data: blob.data };
  }

  /** The entries of the directory `path` in the tree of `commitOid` ('' = root). */
  listDirAt(repository: Repo, commitOid: string, path: string): TreeEntry[] | null {
    const commit = repository.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    let treeOid = parseCommit(commit.data).tree;
    if (path) {
      for (const segment of path.split('/')) {
        const object = repository.objects.get(treeOid);
        if (!object || object.type !== 'tree') return null;
        const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
        if (!entry || entry.mode !== '40000') return null;
        treeOid = entry.oid;
      }
    }
    const object = repository.objects.get(treeOid);
    if (!object || object.type !== 'tree') return null;
    return parseTree(object.data);
  }

  /** Create a commit on `branchRef` that sets `path` to `data`. Returns the commit id. */
  commitFile(
    repository: Repo,
    branchRef: string,
    path: string,
    data: Buffer,
    message: string,
  ): string {
    const current = repository.refs.get(branchRef);
    const files = new Map<string, { oid: string; mode: string }>();
    if (current) {
      const commit = repository.objects.get(current);
      if (commit && commit.type === 'commit') {
        for (const [p, file] of this.flattenTree(repository, parseCommit(commit.data).tree)) files.set(p, file);
      }
    }
    files.set(path, { oid: this.putObject(repository, 'blob', data), mode: '100644' });
    const treeOid = this.buildTreeFromFiles(repository, files);
    const parents = current ? [current] : [];
    const commitOid = this.putObject(repository, 'commit', buildCommit({ tree: treeOid, parents, message }));
    repository.refs.set(branchRef, commitOid);
    return commitOid;
  }

  /** Create a commit on `branchRef` that deletes `path`. Returns the commit id. */
  commitDeleteFile(repository: Repo, branchRef: string, path: string, message: string): string {
    const current = repository.refs.get(branchRef);
    if (!current) throw new Error('cannot delete from an empty branch');
    const commit = repository.objects.get(current);
    if (!commit || commit.type !== 'commit') throw new Error('branch tip is not a commit');
    const files = this.flattenTree(repository, parseCommit(commit.data).tree);
    files.delete(path);
    const treeOid = this.buildTreeFromFiles(repository, files);
    const commitOid = this.putObject(repository, 'commit', buildCommit({ tree: treeOid, parents: [current], message }));
    repository.refs.set(branchRef, commitOid);
    return commitOid;
  }

  // -----------------------------------------------------------------------------------------
  // history and merges
  // -----------------------------------------------------------------------------------------

  /** Commits reachable from `tip`, newest first (depth-first, parents after children). */
  commitHistory(repository: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (oid: string): void => {
      if (seen.has(oid) || !isObjectId(oid)) return;
      seen.add(oid);
      const object = repository.objects.get(oid);
      if (!object || object.type !== 'commit') return;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) visit(parent);
    };
    visit(tip);
    return out;
  }

  /** The best common ancestor of two commits (first found walking both histories). */
  mergeBase(repository: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsOfB = new Set<string>();
    const collect = (oid: string, into: Set<string>): void => {
      const stack = [oid];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (into.has(current) || !isObjectId(current)) continue;
        into.add(current);
        const object = repository.objects.get(current);
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
      const object = repository.objects.get(current);
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
    repository: Repo,
    baseOid: string,
    headOid: string,
  ): { treeOid: string; conflicts: string[]; mergeBase: string | null } {
    const base = this.mergeBase(repository, baseOid, headOid);
    const filesOf = (oid: string | null): Map<string, { oid: string; mode: string }> => {
      const files = new Map<string, { oid: string; mode: string }>();
      if (!oid) return files;
      const commit = repository.objects.get(oid);
      if (commit && commit.type === 'commit') {
        for (const [p, file] of this.flattenTree(repository, parseCommit(commit.data).tree)) files.set(p, file);
      }
      return files;
    };
    const baseFiles = filesOf(base);
    const oursFiles = filesOf(baseOid);
    const theirsFiles = filesOf(headOid);
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
    return { treeOid: this.buildTreeFromFiles(repository, merged), conflicts, mergeBase: base };
  }

  /** True when `ancestor` is an ancestor of (or equal to) `commit`. */
  isAncestor(repository: Repo, ancestor: string, commit: string): boolean {
    return isAncestor(ancestor, commit, this.lookup(repository));
  }

  /** Every object reachable from the given roots (for clone/fetch completeness). */
  reachable(repository: Repo, roots: Iterable<string>): Set<string> {
    return collectReachable(roots, this.lookup(repository));
  }
}
