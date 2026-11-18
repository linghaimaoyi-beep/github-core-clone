// graphql.ts — a small GraphQL executor for the documents the suite sends:
// viewer, repository, node, __type, issue/pull-request connections with
// cursor pagination, and the five mutations. Unknown fields answer HTTP 200
// with an errors array; an unknown repository answers data.repository null
// with no errors.

import { buildCommit, parseCommit } from './git.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';
import { badRequest, jsonResponse, type HttpRequest, type HttpResponse } from './httputil.ts';

// -------------------------------------------------------------------------------------------
// global ids (opaque, stable): base64 of "Type:key:..."
// -------------------------------------------------------------------------------------------

/** Encode a global id: base64 of "Kind:key". */
function encodeGlobalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

/** Decode a global id back to its kind and key; null when malformed. */
function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** Encode a connection cursor for list position `index`. */
function encodePageCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

/** Decode a connection cursor back to its list position; null when malformed. */
function decodePageCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice(7), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// parser (recursive descent over the query subset the suite uses)
// -------------------------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface FieldSel {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: GqlValue }>;
  readonly selections: Sel[];
}

interface SpreadSel {
  readonly kind: 'spread';
  readonly name: string;
}

interface InlineSel {
  readonly kind: 'inline';
  readonly typeCondition: string | null;
  readonly selections: Sel[];
}

type Sel = FieldSel | SpreadSel | InlineSel;

interface GqlOperation {
  readonly operation: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: Array<{ name: string; defaultValue: GqlValue | null }>;
  readonly selections: Sel[];
}

interface Fragment {
  readonly name: string;
  readonly typeCondition: string;
  readonly selections: Sel[];
}

class Parser {
  private at = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  private skipSpace(): void {
    for (;;) {
      const ch = this.src[this.at];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        this.at += 1;
        continue;
      }
      if (ch === '#') {
        while (this.at < this.src.length && this.src[this.at] !== '\n') this.at += 1;
        continue;
      }
      break;
    }
  }

  private peekChar(): string {
    this.skipSpace();
    return this.src[this.at] ?? '';
  }

  private readIdent(): string {
    this.skipSpace();
    const start = this.at;
    while (this.at < this.src.length && /[_A-Za-z0-9]/.test(this.src[this.at]!)) this.at += 1;
    if (this.at === start) throw new Error(`expected a name at ${this.at}`);
    return this.src.slice(start, this.at);
  }

  private expect(ch: string): void {
    this.skipSpace();
    if (this.src[this.at] !== ch) throw new Error(`expected ${JSON.stringify(ch)} at ${this.at}`);
    this.at += 1;
  }

  private tryChar(ch: string): boolean {
    this.skipSpace();
    if (this.src[this.at] === ch) {
      this.at += 1;
      return true;
    }
    return false;
  }

  private readQuoted(): string {
    this.skipSpace();
    if (this.src[this.at] !== '"') throw new Error(`expected a string at ${this.at}`);
    this.at += 1;
    let out = '';
    while (this.at < this.src.length) {
      const ch = this.src[this.at]!;
      if (ch === '"') {
        this.at += 1;
        return out;
      }
      if (ch === '\\') {
        this.at += 1;
        const esc = this.src[this.at] ?? '';
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else out += esc;
        this.at += 1;
        continue;
      }
      out += ch;
      this.at += 1;
    }
    throw new Error('unterminated string');
  }

  private readLiteral(): GqlValue {
    this.skipSpace();
    const ch = this.src[this.at] ?? '';
    if (ch === '$') {
      this.at += 1;
      return { kind: 'variable', name: this.readIdent() };
    }
    if (ch === '"') return { kind: 'string', value: this.readQuoted() };
    if (ch === '[') {
      this.at += 1;
      const values: GqlValue[] = [];
      while (!this.tryChar(']')) values.push(this.readLiteral());
      return { kind: 'list', values };
    }
    if (ch === '{') {
      this.at += 1;
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!this.tryChar('}')) {
        const name = this.readIdent();
        this.expect(':');
        fields.push({ name, value: this.readLiteral() });
      }
      return { kind: 'object', fields };
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const start = this.at;
      if (this.src[this.at] === '-') this.at += 1;
      while (/[0-9]/.test(this.src[this.at] ?? '')) this.at += 1;
      let isFloat = false;
      if (this.src[this.at] === '.') {
        isFloat = true;
        this.at += 1;
        while (/[0-9]/.test(this.src[this.at] ?? '')) this.at += 1;
      }
      if (this.src[this.at] === 'e' || this.src[this.at] === 'E') {
        isFloat = true;
        this.at += 1;
        if (this.src[this.at] === '+' || this.src[this.at] === '-') this.at += 1;
        while (/[0-9]/.test(this.src[this.at] ?? '')) this.at += 1;
      }
      const num = Number(this.src.slice(start, this.at));
      return isFloat ? { kind: 'float', value: num } : { kind: 'int', value: num };
    }
    const name = this.readIdent();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  private skipDirectives(): void {
    // Directives (@include, @skip, ...) are not used by the suite; skip them.
    while (this.peekChar() === '@') {
      this.at += 1;
      this.readIdent();
      this.skipSpace();
      if (this.src[this.at] === '(') {
        this.at += 1;
        let depth = 1;
        while (this.at < this.src.length && depth > 0) {
          const ch = this.src[this.at]!;
          if (ch === '(') depth += 1;
          else if (ch === ')') depth -= 1;
          this.at += 1;
        }
      }
    }
  }

  private readArgs(): Array<{ name: string; value: GqlValue }> {
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (!this.tryChar('(')) return args;
    while (!this.tryChar(')')) {
      const name = this.readIdent();
      this.expect(':');
      args.push({ name, value: this.readLiteral() });
    }
    return args;
  }

  private readSelSet(): Sel[] {
    this.expect('{');
    const selections: Sel[] = [];
    while (!this.tryChar('}')) {
      if (this.src.slice(this.at, this.at + 3) === '...') {
        this.at += 3;
        this.skipSpace();
        if (this.src.slice(this.at, this.at + 2) === 'on') {
          this.at += 2;
          const typeCondition = this.readIdent();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: this.readSelSet() });
        } else {
          const name = this.readIdent();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      const first = this.readIdent();
      let alias: string | null = null;
      let name = first;
      this.skipSpace();
      if (this.src[this.at] === ':') {
        this.at += 1;
        alias = first;
        name = this.readIdent();
      }
      const args = this.readArgs();
      this.skipDirectives();
      let sub: Sel[] = [];
      if (this.peekChar() === '{') sub = this.readSelSet();
      selections.push({ kind: 'field', alias, name, args, selections: sub });
    }
    return selections;
  }

  parse(): { operations: GqlOperation[]; fragments: Map<string, Fragment> } {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.at < this.src.length) {
      this.skipSpace();
      if (this.at >= this.src.length) break;
      if (this.src.slice(this.at, this.at + 8) === 'fragment') {
        this.at += 8;
        const name = this.readIdent();
        this.skipSpace();
        if (this.src.slice(this.at, this.at + 2) !== 'on') throw new Error('fragment needs "on"');
        this.at += 2;
        const typeCondition = this.readIdent();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selections: this.readSelSet() });
        continue;
      }
      let operation: 'query' | 'mutation' = 'query';
      let name: string | null = null;
      if (this.peekChar() === '{') {
        operations.push({ operation: 'query', name: null, variables: [], selections: this.readSelSet() });
        continue;
      }
      const keyword = this.readIdent();
      if (keyword === 'query' || keyword === 'mutation') operation = keyword;
      else throw new Error(`unsupported operation ${JSON.stringify(keyword)}`);
      this.skipSpace();
      if (/[_A-Za-z]/.test(this.peekChar())) name = this.readIdent();
      // Variable definitions.
      const variables: Array<{ name: string; defaultValue: GqlValue | null }> = [];
      if (this.tryChar('(')) {
        while (!this.tryChar(')')) {
          this.skipSpace();
          if (this.src[this.at] === '$') this.at += 1;
          const varName = this.readIdent();
          this.expect(':');
          // Skip the type (a name, possibly with ! or [ ]).
          this.skipSpace();
          while (/[_A-Za-z0-9!\[\]]/.test(this.src[this.at] ?? '')) this.at += 1;
          let defaultValue: GqlValue | null = null;
          this.skipSpace();
          if (this.src[this.at] === '=') {
            this.at += 1;
            defaultValue = this.readLiteral();
          }
          variables.push({ name: varName, defaultValue });
        }
      }
      this.skipDirectives();
      operations.push({ operation, name, variables, selections: this.readSelSet() });
    }
    return { operations, fragments };
  }
}

// -------------------------------------------------------------------------------------------
// values
// -------------------------------------------------------------------------------------------

/** Evaluate a parsed literal against the operation's variables. */
function evalValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'int':
    case 'float':
      return value.value;
    case 'string':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

/** Evaluate a field's arguments into a name → value map. */
function evalArgs(
  field: FieldSel,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

// -------------------------------------------------------------------------------------------
// executor
// -------------------------------------------------------------------------------------------

interface TypedValue {
  readonly __typename: string;
  readonly data: unknown;
}

interface Scope {
  store: Forge;
  owner: string;
  errors: Array<{ message: string }>;
  variables: Record<string, unknown>;
  fragments: Map<string, Fragment>;
}

/** Wrap `data` as a value of GraphQL type `typename`. */
function typed(typename: string, data: unknown): TypedValue {
  return { __typename: typename, data };
}

/** Find a repository by its numeric id. */
function findRepoById(store: Forge, id: number): Repo | undefined {
  for (const repository of store.repos.values()) if (repository.id === id) return repository;
  return undefined;
}

/** Find an issue by its global-id key ("repoId:number"). */
function findIssueByKey(store: Forge, key: string): { repo: Repo; issue: Issue } | null {
  const parts = key.split(':');
  const repository = findRepoById(store, Number.parseInt(parts[0] ?? '', 10));
  if (!repository) return null;
  const issue = repository.issues.find((candidate) => candidate.number === Number.parseInt(parts[1] ?? '', 10));
  if (!issue) return null;
  return { repo: repository, issue };
}

/** Find a pull request by its global-id key ("repoId:number"). */
function findPullByKey(store: Forge, key: string): { repo: Repo; pull: Pull } | null {
  const parts = key.split(':');
  const repository = findRepoById(store, Number.parseInt(parts[0] ?? '', 10));
  if (!repository) return null;
  const pull = repository.pulls.find((candidate) => candidate.number === Number.parseInt(parts[1] ?? '', 10));
  if (!pull) return null;
  return { repo: repository, pull };
}

/** Slice `items` into a connection page (first/after) with edges and pageInfo. */
function paginate<T>(
  items: readonly T[],
  args: Record<string, unknown>,
  toNode: (item: T) => unknown,
): Record<string, unknown> {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : undefined;
  const after = typeof args.after === 'string' ? decodePageCursor(args.after) : null;
  const start = after === null ? 0 : after + 1;
  const end = first === undefined ? items.length : Math.min(items.length, start + first);
  const page = items.slice(start, end);
  const edges = page.map((item, index) => ({
    cursor: encodePageCursor(start + index),
    node: toNode(item),
  }));
  return {
    nodes: page.map(toNode),
    edges,
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length ? edges[0]!.cursor : null,
      endCursor: edges.length ? edges[edges.length - 1]!.cursor : null,
    },
    totalCount: items.length,
  };
}

/** Sort issues the way the suite orders them: created desc, ties by number desc. */
function orderIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const order = (orderBy as { field?: string; direction?: string } | undefined) ?? {};
  const direction = order.direction === 'ASC' ? 1 : -1;
  return [...issues].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return (a.createdAt - b.createdAt) * direction;
    return (a.number - b.number) * direction;
  });
}

/** Resolve one field on `parent` (null at the root). */
function resolveField(scope: Scope, parent: TypedValue | null, field: FieldSel): unknown {
  const args = evalArgs(field, scope.variables);
  const typename = parent?.__typename ?? 'Query';
  const data = parent?.data;

  // Root Query / Mutation.
  if (parent === null) {
    if (field.name === 'viewer') {
      return typed('User', { login: scope.store.viewerLogin ?? scope.owner, id: 1000 });
    }
    if (field.name === 'repository') {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repository = scope.store.getRepo(owner, name);
      if (!repository) return null;
      return typed('Repository', { repo: repository, owner });
    }
    if (field.name === 'node') {
      const id = typeof args.id === 'string' ? args.id : '';
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repository = findRepoById(scope.store, Number.parseInt(decoded.key, 10));
        if (!repository) return null;
        return typed('Repository', { repo: repository, owner: scope.store.viewerLogin ?? '' });
      }
      if (decoded.kind === 'Issue') {
        const found = findIssueByKey(scope.store, decoded.key);
        if (!found) return null;
        return typed('Issue', { repo: found.repo, issue: found.issue });
      }
      if (decoded.kind === 'PullRequest') {
        const found = findPullByKey(scope.store, decoded.key);
        if (!found) return null;
        return typed('PullRequest', { repo: found.repo, pull: found.pull });
      }
      return null;
    }
    if (field.name === '__type') {
      const name = typeof args.name === 'string' ? args.name : '';
      return typed('__Type', { name });
    }
    if (field.name === 'createIssue') return doCreateIssue(scope, args);
    if (field.name === 'closeIssue') return doCloseIssue(scope, args);
    if (field.name === 'createPullRequest') return doCreatePullRequest(scope, args);
    if (field.name === 'mergePullRequest') return doMergePullRequest(scope, args);
    if (field.name === 'addComment') return doAddComment(scope, args);
    scope.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "Query".` });
    return null;
  }

  if (typename === 'User') {
    const user = data as { login: string; id: number };
    if (field.name === 'login') return user.login;
    if (field.name === 'id') return encodeGlobalId('User', String(user.id));
    if (field.name === 'databaseId') return user.id;
    if (field.name === 'name') return user.login;
    if (field.name === 'email') return `${user.login}@example.invalid`;
    scope.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "User".` });
    return null;
  }

  if (typename === 'Repository') {
    const { repo, owner } = data as { repo: Repo; owner: string };
    switch (field.name) {
      case 'id':
        return encodeGlobalId('Repository', String(repo.id));
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${owner}/${repo.name}`;
      case 'owner':
        return typed('User', { login: owner, id: 1000 });
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return null;
        return typed('Ref', { name: repo.defaultBranch, target: tip });
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.private;
      case 'url':
        return `https://example.invalid/${owner}/${repo.name}`;
      case 'createdAt':
        return new Date().toISOString();
      case 'issue': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const issue = repo.issues.find((candidate) => candidate.number === number);
        if (!issue) return null;
        return typed('Issue', { repo, issue });
      }
      case 'issues': {
        let issues = [...repo.issues];
        if (Array.isArray(args.states)) {
          const wanted = new Set(args.states.map((state) => String(state)));
          issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        issues = orderIssues(issues, args.orderBy);
        return paginate(issues, args, (issue) => typed('Issue', { repo, issue }));
      }
      case 'pullRequest': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const pull = repo.pulls.find((candidate) => candidate.number === number);
        if (!pull) return null;
        return typed('PullRequest', { repo, pull });
      }
      case 'pullRequests': {
        let pulls = [...repo.pulls];
        if (Array.isArray(args.states)) {
          const wanted = new Set(args.states.map((state) => String(state)));
          pulls = pulls.filter((pull) =>
            wanted.has(pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED'),
          );
        }
        pulls = [...pulls].sort((a, b) => b.createdAt - a.createdAt);
        return paginate(pulls, args, (pull) => typed('PullRequest', { repo, pull }));
      }
      default:
        scope.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "Repository".` });
        return null;
    }
  }

  if (typename === 'Issue') {
    const { repo, issue } = data as { repo: Repo; issue: Issue };
    switch (field.name) {
      case 'id':
        return encodeGlobalId('Issue', `${repo.id}:${issue.number}`);
      case 'databaseId':
        return issue.number;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'createdAt':
        return new Date().toISOString();
      case 'labels':
        return { nodes: issue.labels.map((label) => typed('Label', label)) };
      case 'comments':
        return paginate(issue.comments, args, (comment) =>
          typed('IssueComment', { repo, issue, comment }),
        );
      case 'repository':
        return typed('Repository', { repo, owner: scope.store.viewerLogin ?? '' });
      case 'author':
        return typed('User', { login: scope.store.viewerLogin ?? '', id: 1000 });
      case 'url':
        return `https://example.invalid/${scope.store.viewerLogin ?? ''}/${repo.name}/issues/${issue.number}`;
      default:
        scope.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "Issue".` });
        return null;
    }
  }

  if (typename === 'PullRequest') {
    const { repo, pull } = data as { repo: Repo; pull: Pull };
    switch (field.name) {
      case 'id':
        return encodeGlobalId('PullRequest', `${repo.id}:${pull.number}`);
      case 'databaseId':
        return pull.number;
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRefOid':
        return pull.headSha;
      case 'baseRefOid':
        return pull.baseSha;
      case 'merged':
        return pull.merged;
      case 'mergeable': {
        // GitHub's MergeableState enum, judged against the base branch as it
        // stands now.
        const currentBase = scope.store.getRef(repo, `refs/heads/${pull.baseRef}`);
        if (!currentBase || !scope.store.getObject(repo, pull.headSha)) return 'UNKNOWN';
        const merged = scope.store.threeWayMerge(repo, currentBase, pull.headSha);
        return merged.conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'mergeCommit':
        return pull.mergeCommitSha ? typed('Commit', { oid: pull.mergeCommitSha }) : null;
      case 'createdAt':
        return new Date().toISOString();
      case 'files': {
        const baseCommit = scope.store.getObject(repo, pull.baseSha);
        const headCommit = scope.store.getObject(repo, pull.headSha);
        if (!baseCommit || !headCommit) return paginate([], args, (x: string) => x);
        const baseFiles = scope.store.flattenTree(repo, parseCommit(baseCommit.data).tree);
        const headFiles = scope.store.flattenTree(repo, parseCommit(headCommit.data).tree);
        const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
        const changed: string[] = [];
        for (const path of [...paths].sort()) {
          if (baseFiles.get(path)?.oid !== headFiles.get(path)?.oid) changed.push(path);
        }
        return paginate(changed, args, (path) => typed('PullRequestFile', { path }));
      }
      case 'repository':
        return typed('Repository', { repo, owner: scope.store.viewerLogin ?? '' });
      case 'author':
        return typed('User', { login: scope.store.viewerLogin ?? '', id: 1000 });
      case 'url':
        return `https://example.invalid/${scope.store.viewerLogin ?? ''}/${repo.name}/pull/${pull.number}`;
      default:
        scope.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "PullRequest".` });
        return null;
    }
  }

  if (typename === 'Ref') {
    const ref = data as { name: string; target: string };
    if (field.name === 'name') return ref.name;
    if (field.name === 'target') return typed('Commit', { oid: ref.target });
    scope.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "Ref".` });
    return null;
  }

  if (typename === 'Commit') {
    const commit = data as { oid: string };
    if (field.name === 'oid') return commit.oid;
    if (field.name === 'id') return encodeGlobalId('Commit', commit.oid);
    scope.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "Commit".` });
    return null;
  }

  if (typename === 'Label') {
    const label = data as { name: string; color: string };
    if (field.name === 'name') return label.name;
    if (field.name === 'color') return label.color;
    if (field.name === 'id') return encodeGlobalId('Label', label.name);
    scope.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "Label".` });
    return null;
  }

  if (typename === 'IssueComment') {
    const { comment } = data as { comment: { id: number; body: string } };
    if (field.name === 'id') return encodeGlobalId('IssueComment', String(comment.id));
    if (field.name === 'databaseId') return comment.id;
    if (field.name === 'body') return comment.body;
    scope.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "IssueComment".` });
    return null;
  }

  if (typename === 'PullRequestFile') {
    const file = data as { path: string };
    if (field.name === 'path') return file.path;
    scope.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "PullRequestFile".` });
    return null;
  }

  if (typename === '__Type') {
    const type = data as { name: string };
    return introspect(type.name, field);
  }

  scope.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type ${JSON.stringify(typename)}.` });
  return null;
}

// -------------------------------------------------------------------------------------------
// introspection
// -------------------------------------------------------------------------------------------

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'author', 'repository', 'url', 'databaseId'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'mergeCommit', 'files', 'commits', 'createdAt', 'updatedAt', 'author', 'repository', 'url', 'databaseId'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'description', 'isPrivate', 'url'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url'],
  SearchType: [],
};

const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
};

/** Answer an introspection field (__type) for `name`. */
function introspect(name: string, field: FieldSel): unknown {
  if (field.name === 'name') return name;
  if (field.name === 'kind') return INTROSPECTION_ENUMS[name] ? 'ENUM' : 'OBJECT';
  if (field.name === 'fields') {
    const fields = INTROSPECTION_FIELDS[name] ?? [];
    return fields.map((fieldName) => ({ name: fieldName }));
  }
  if (field.name === 'enumValues') {
    const values = INTROSPECTION_ENUMS[name] ?? [];
    return values.map((value) => ({ name: value }));
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// mutations
// -------------------------------------------------------------------------------------------

function doCreateIssue(scope: Scope, args: Record<string, unknown>): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
  const decoded = decodeGlobalId(repositoryId);
  const repository = decoded?.kind === 'Repository' ? findRepoById(scope.store, Number.parseInt(decoded.key, 10)) : undefined;
  if (!repository) {
    scope.errors.push({ message: 'repository not found' });
    return { issue: null };
  }
  const title = typeof input.title === 'string' ? input.title : '';
  const issue: Issue = {
    number: repository.issueSeq++,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    createdAt: scope.store.nextSeq(),
    comments: [],
  };
  repository.issues.push(issue);
  return typed('CreateIssuePayload', { repo: repository, issue });
}

function doCloseIssue(scope: Scope, args: Record<string, unknown>): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const issueId = typeof input.issueId === 'string' ? input.issueId : '';
  const decoded = decodeGlobalId(issueId);
  const found = decoded?.kind === 'Issue' ? findIssueByKey(scope.store, decoded.key) : null;
  if (!found) {
    scope.errors.push({ message: 'issue not found' });
    return { issue: null };
  }
  found.issue.state = 'closed';
  return typed('CloseIssuePayload', { repo: found.repo, issue: found.issue });
}

function doCreatePullRequest(scope: Scope, args: Record<string, unknown>): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
  const decoded = decodeGlobalId(repositoryId);
  const repository = decoded?.kind === 'Repository' ? findRepoById(scope.store, Number.parseInt(decoded.key, 10)) : undefined;
  if (!repository) {
    scope.errors.push({ message: 'repository not found' });
    return { pullRequest: null };
  }
  const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
  const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
  const headSha = scope.store.getRef(repository, `refs/heads/${headRef}`);
  const baseSha = scope.store.getRef(repository, `refs/heads/${baseRef}`);
  if (!headSha || !baseSha) {
    scope.errors.push({ message: 'head or base branch does not exist' });
    return { pullRequest: null };
  }
  const pull: Pull = {
    number: repository.pullSeq++,
    title: typeof input.title === 'string' ? input.title : '',
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: scope.store.nextSeq(),
  };
  repository.pulls.push(pull);
  return typed('CreatePullRequestPayload', { repo: repository, pull });
}

function doMergePullRequest(scope: Scope, args: Record<string, unknown>): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
  const decoded = decodeGlobalId(pullRequestId);
  const found = decoded?.kind === 'PullRequest' ? findPullByKey(scope.store, decoded.key) : null;
  if (!found) {
    scope.errors.push({ message: 'pull request not found' });
    return { pullRequest: null };
  }
  const { repo, pull } = found;
  const mergeMethod = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE';
  if (pull.merged || pull.state === 'closed') {
    scope.errors.push({ message: 'pull request is already merged or closed' });
    return typed('MergePullRequestPayload', { repo, pull });
  }
  const baseRef = `refs/heads/${pull.baseRef}`;
  // Merge against the base branch as it stands now, not the tip recorded
  // when the pull request was opened.
  const currentBase = scope.store.getRef(repo, baseRef);
  if (!currentBase) {
    scope.errors.push({ message: 'base branch does not exist' });
    return typed('MergePullRequestPayload', { repo, pull });
  }
  const merged = scope.store.threeWayMerge(repo, currentBase, pull.headSha);
  if (merged.conflicts.length > 0) {
    scope.errors.push({ message: `merge conflict in ${merged.conflicts.join(', ')}` });
    return typed('MergePullRequestPayload', { repo, pull });
  }
  const message = mergeMethod === 'SQUASH' ? pull.title : `Merge pull request #${pull.number} from ${pull.headRef}`;
  const parents = mergeMethod === 'MERGE' ? [currentBase, pull.headSha] : [currentBase];
  const mergeCommit = scope.store.putObject(repo, 'commit', buildCommit({ tree: merged.treeOid, parents, message }));
  scope.store.setRef(repo, baseRef, mergeCommit);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = mergeCommit;
  return typed('MergePullRequestPayload', { repo, pull });
}

function doAddComment(scope: Scope, args: Record<string, unknown>): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
  const decoded = decodeGlobalId(subjectId);
  if (decoded?.kind !== 'Issue') {
    scope.errors.push({ message: 'subject is not an issue' });
    return { commentEdge: null };
  }
  const found = findIssueByKey(scope.store, decoded.key);
  if (!found) {
    scope.errors.push({ message: 'issue not found' });
    return { commentEdge: null };
  }
  const comment = { id: found.repo.commentSeq++, body: typeof input.body === 'string' ? input.body : '', createdAt: scope.store.nextSeq() };
  found.issue.comments.push(comment);
  return typed('AddCommentPayload', { repo: found.repo, issue: found.issue, comment });
}

// Payload field resolution: a payload object exposes its named child.
function resolvePayloadField(scope: Scope, parent: TypedValue, field: FieldSel): unknown {
  const data = parent.data as Record<string, unknown>;
  if (field.name === 'issue' && data.issue) return typed('Issue', { repo: data.repo, issue: data.issue });
  if (field.name === 'pullRequest' && data.pull) return typed('PullRequest', { repo: data.repo, pull: data.pull });
  if (field.name === 'commentEdge' && data.comment) {
    return typed('IssueCommentEdge', { repo: data.repo, issue: data.issue, comment: data.comment });
  }
  if (field.name === 'clientMutationId') return null;
  scope.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type ${JSON.stringify(parent.__typename)}.` });
  return null;
}

/** Execute a list of selections against `parent` (null at the root). */
function resolveSelections(
  scope: Scope,
  parent: TypedValue | null,
  selections: Sel[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = scope.fragments.get(selection.name);
      if (!fragment) {
        scope.errors.push({ message: `Unknown fragment ${JSON.stringify(selection.name)}.` });
        continue;
      }
      Object.assign(out, resolveSelections(scope, parent, fragment.selections));
      continue;
    }
    if (selection.kind === 'inline') {
      const typename = parent?.__typename ?? 'Query';
      if (selection.typeCondition && selection.typeCondition !== typename) continue;
      Object.assign(out, resolveSelections(scope, parent, selection.selections));
      continue;
    }
    const key = selection.alias ?? selection.name;
    let value: unknown;
    if (parent !== null && parent.__typename.endsWith('Payload')) {
      value = resolvePayloadField(scope, parent, selection);
    } else if (parent !== null && parent.__typename === 'IssueCommentEdge') {
      if (selection.name === 'node') {
        const data = parent.data as { repo: Repo; issue: Issue; comment: { id: number; body: string } };
        value = typed('IssueComment', { repo: data.repo, issue: data.issue, comment: data.comment });
      } else {
        scope.errors.push({ message: `Cannot query field ${JSON.stringify(selection.name)} on type "IssueCommentEdge".` });
        value = null;
      }
    } else {
      value = resolveField(scope, parent, selection);
    }
    if (value instanceof Object && value !== null && '__typename' in value && selection.selections.length > 0) {
      value = resolveSelections(scope, value as TypedValue, selection.selections);
    } else if (Array.isArray(value)) {
      // A list of objects (e.g. connection nodes handled inside the field).
      value = value.map((item) =>
        item instanceof Object && item !== null && '__typename' in item && selection.selections.length > 0
          ? resolveSelections(scope, item as TypedValue, selection.selections)
          : item,
      );
    } else if (
      value !== null &&
      typeof value === 'object' &&
      !Buffer.isBuffer(value) &&
      selection.selections.length > 0
    ) {
      // A plain object (e.g. a connection): recurse into its TypedValue leaves.
      value = resolvePlain(scope, value as Record<string, unknown>, selection.selections);
    }
    out[key] = value;
  }
  return out;
}

/** Recurse into a plain object (a connection), executing sub-selections on any TypedValue leaves. */
function resolvePlain(
  scope: Scope,
  obj: Record<string, unknown>,
  selections: Sel[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value instanceof Object && value !== null && '__typename' in value) {
      const field = selections.find((s): s is FieldSel => s.kind === 'field' && (s.alias ?? s.name) === key);
      out[key] = field && field.selections.length > 0 ? resolveSelections(scope, value as TypedValue, field.selections) : value;
    } else if (Array.isArray(value)) {
      const field = selections.find((s): s is FieldSel => s.kind === 'field' && (s.alias ?? s.name) === key);
      out[key] = value.map((item) => {
        if (item instanceof Object && item !== null && '__typename' in item && field && field.selections.length > 0) {
          return resolveSelections(scope, item as TypedValue, field.selections);
        }
        if (item !== null && typeof item === 'object' && field && field.selections.length > 0) {
          return resolvePlain(scope, item as Record<string, unknown>, field.selections);
        }
        return item;
      });
    } else if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value)) {
      const field = selections.find((s): s is FieldSel => s.kind === 'field' && (s.alias ?? s.name) === key);
      out[key] = field && field.selections.length > 0 ? resolvePlain(scope, value as Record<string, unknown>, field.selections) : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Run one parsed operation and return its {data, errors?}. */
function runOperation(
  store: Forge,
  owner: string,
  operation: GqlOperation,
  variables: Record<string, unknown>,
  fragments: Map<string, Fragment>,
): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const scope: Scope = { store, owner, errors: [], variables, fragments };
  const data = resolveSelections(scope, null, operation.selections);
  return scope.errors.length > 0 ? { data, errors: scope.errors } : { data };
}

export function handleGraphQL(store: Forge, req: HttpRequest): HttpResponse | null {
  if (req.pathname !== '/api/graphql') return null;
  if (req.method !== 'POST') return jsonResponse(405, { message: 'Method Not Allowed' });
  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return badRequest('request body is not valid JSON');
  }
  const owner = store.viewerLogin ?? '';
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return { data: null, errors: [{ message: 'request body must be a GraphQL operation object' }] };
    }
    const query = (doc as { query?: unknown }).query;
    const variables = ((doc as { variables?: unknown }).variables ?? {}) as Record<string, unknown>;
    if (typeof query !== 'string') {
      return { data: null, errors: [{ message: 'query must be a string' }] };
    }
    let parsed;
    try {
      parsed = new Parser(query).parse();
    } catch (err) {
      return { data: null, errors: [{ message: `syntax error: ${(err as Error).message}` }] };
    }
    const operationName = (doc as { operationName?: unknown }).operationName;
    let operation = parsed.operations[0];
    if (typeof operationName === 'string') {
      operation = parsed.operations.find((candidate) => candidate.name === operationName) ?? operation;
    }
    if (!operation) return { data: null, errors: [{ message: 'no operation found' }] };
    // Apply variable defaults.
    const vars: Record<string, unknown> = { ...variables };
    for (const variable of operation.variables) {
      if (vars[variable.name] === undefined && variable.defaultValue !== null) {
        vars[variable.name] = evalValue(variable.defaultValue, vars);
      }
    }
    return runOperation(store, owner, operation, vars, parsed.fragments);
  };
  if (Array.isArray(body)) {
    return jsonResponse(200, body.map(runOne));
  }
  return jsonResponse(200, runOne(body));
}
