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

function encodeId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function decodeId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
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

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldSelection {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: Value }>;
  readonly selections: Selection[];
}

interface FragmentSpreadSelection {
  readonly kind: 'spread';
  readonly name: string;
}

interface InlineFragmentSelection {
  readonly kind: 'inline';
  readonly typeCondition: string | null;
  readonly selections: Selection[];
}

type Selection = FieldSelection | FragmentSpreadSelection | InlineFragmentSelection;

interface Operation {
  readonly operation: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: Array<{ name: string; defaultValue: Value | null }>;
  readonly selections: Selection[];
}

interface FragmentDef {
  readonly name: string;
  readonly typeCondition: string;
  readonly selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private skipIgnored(): void {
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  private peek(): string {
    this.skipIgnored();
    return this.text[this.pos] ?? '';
  }

  private readName(): string {
    this.skipIgnored();
    const start = this.pos;
    while (this.pos < this.text.length && /[_A-Za-z0-9]/.test(this.text[this.pos]!)) this.pos += 1;
    if (this.pos === start) throw new Error(`expected a name at ${this.pos}`);
    return this.text.slice(start, this.pos);
  }

  private expectChar(ch: string): void {
    this.skipIgnored();
    if (this.text[this.pos] !== ch) throw new Error(`expected ${JSON.stringify(ch)} at ${this.pos}`);
    this.pos += 1;
  }

  private matchChar(ch: string): boolean {
    this.skipIgnored();
    if (this.text[this.pos] === ch) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private readString(): string {
    this.skipIgnored();
    if (this.text[this.pos] !== '"') throw new Error(`expected a string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]!;
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        this.pos += 1;
        const esc = this.text[this.pos] ?? '';
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else out += esc;
        this.pos += 1;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    throw new Error('unterminated string');
  }

  private readValue(): Value {
    this.skipIgnored();
    const ch = this.text[this.pos] ?? '';
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.readName() };
    }
    if (ch === '"') return { kind: 'string', value: this.readString() };
    if (ch === '[') {
      this.pos += 1;
      const values: Value[] = [];
      while (!this.matchChar(']')) values.push(this.readValue());
      return { kind: 'list', values };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: Array<{ name: string; value: Value }> = [];
      while (!this.matchChar('}')) {
        const name = this.readName();
        this.expectChar(':');
        fields.push({ name, value: this.readValue() });
      }
      return { kind: 'object', fields };
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const start = this.pos;
      if (this.text[this.pos] === '-') this.pos += 1;
      while (/[0-9]/.test(this.text[this.pos] ?? '')) this.pos += 1;
      let isFloat = false;
      if (this.text[this.pos] === '.') {
        isFloat = true;
        this.pos += 1;
        while (/[0-9]/.test(this.text[this.pos] ?? '')) this.pos += 1;
      }
      if (this.text[this.pos] === 'e' || this.text[this.pos] === 'E') {
        isFloat = true;
        this.pos += 1;
        if (this.text[this.pos] === '+' || this.text[this.pos] === '-') this.pos += 1;
        while (/[0-9]/.test(this.text[this.pos] ?? '')) this.pos += 1;
      }
      const num = Number(this.text.slice(start, this.pos));
      return isFloat ? { kind: 'float', value: num } : { kind: 'int', value: num };
    }
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  private readDirectives(): void {
    // Directives (@include, @skip, ...) are not used by the suite; skip them.
    while (this.peek() === '@') {
      this.pos += 1;
      this.readName();
      this.skipIgnored();
      if (this.text[this.pos] === '(') {
        this.pos += 1;
        let depth = 1;
        while (this.pos < this.text.length && depth > 0) {
          const ch = this.text[this.pos]!;
          if (ch === '(') depth += 1;
          else if (ch === ')') depth -= 1;
          this.pos += 1;
        }
      }
    }
  }

  private readArguments(): Array<{ name: string; value: Value }> {
    const args: Array<{ name: string; value: Value }> = [];
    if (!this.matchChar('(')) return args;
    while (!this.matchChar(')')) {
      const name = this.readName();
      this.expectChar(':');
      args.push({ name, value: this.readValue() });
    }
    return args;
  }

  private readSelectionSet(): Selection[] {
    this.expectChar('{');
    const selections: Selection[] = [];
    while (!this.matchChar('}')) {
      if (this.text.slice(this.pos, this.pos + 3) === '...') {
        this.pos += 3;
        this.skipIgnored();
        if (this.text.slice(this.pos, this.pos + 2) === 'on') {
          this.pos += 2;
          const typeCondition = this.readName();
          this.readDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: this.readSelectionSet() });
        } else {
          const name = this.readName();
          this.readDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      const first = this.readName();
      let alias: string | null = null;
      let name = first;
      this.skipIgnored();
      if (this.text[this.pos] === ':') {
        this.pos += 1;
        alias = first;
        name = this.readName();
      }
      const args = this.readArguments();
      this.readDirectives();
      let sub: Selection[] = [];
      if (this.peek() === '{') sub = this.readSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selections: sub });
    }
    return selections;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FragmentDef> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.pos < this.text.length) {
      this.skipIgnored();
      if (this.pos >= this.text.length) break;
      if (this.text.slice(this.pos, this.pos + 8) === 'fragment') {
        this.pos += 8;
        const name = this.readName();
        this.skipIgnored();
        if (this.text.slice(this.pos, this.pos + 2) !== 'on') throw new Error('fragment needs "on"');
        this.pos += 2;
        const typeCondition = this.readName();
        this.readDirectives();
        fragments.set(name, { name, typeCondition, selections: this.readSelectionSet() });
        continue;
      }
      let operation: 'query' | 'mutation' = 'query';
      let name: string | null = null;
      if (this.peek() === '{') {
        operations.push({ operation: 'query', name: null, variables: [], selections: this.readSelectionSet() });
        continue;
      }
      const keyword = this.readName();
      if (keyword === 'query' || keyword === 'mutation') operation = keyword;
      else throw new Error(`unsupported operation ${JSON.stringify(keyword)}`);
      this.skipIgnored();
      if (/[_A-Za-z]/.test(this.peek())) name = this.readName();
      // Variable definitions.
      const variables: Array<{ name: string; defaultValue: Value | null }> = [];
      if (this.matchChar('(')) {
        while (!this.matchChar(')')) {
          this.skipIgnored();
          if (this.text[this.pos] === '$') this.pos += 1;
          const varName = this.readName();
          this.expectChar(':');
          // Skip the type (a name, possibly with ! or [ ]).
          this.skipIgnored();
          while (/[_A-Za-z0-9!\[\]]/.test(this.text[this.pos] ?? '')) this.pos += 1;
          let defaultValue: Value | null = null;
          this.skipIgnored();
          if (this.text[this.pos] === '=') {
            this.pos += 1;
            defaultValue = this.readValue();
          }
          variables.push({ name: varName, defaultValue });
        }
      }
      this.readDirectives();
      operations.push({ operation, name, variables, selections: this.readSelectionSet() });
    }
    return { operations, fragments };
  }
}

// -------------------------------------------------------------------------------------------
// values
// -------------------------------------------------------------------------------------------

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
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
      return value.values.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argMap(
  field: FieldSelection,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// -------------------------------------------------------------------------------------------
// executor
// -------------------------------------------------------------------------------------------

interface GqlObject {
  readonly __typename: string;
  readonly data: unknown;
}

interface Ctx {
  forge: Forge;
  owner: string;
  errors: Array<{ message: string }>;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
}

function gqlObj(typename: string, data: unknown): GqlObject {
  return { __typename: typename, data };
}

function repoById(forge: Forge, id: number): Repo | undefined {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function issueByGlobalId(forge: Forge, key: string): { repo: Repo; issue: Issue } | null {
  const parts = key.split(':');
  const repo = repoById(forge, Number.parseInt(parts[0] ?? '', 10));
  if (!repo) return null;
  const issue = repo.issues.find((candidate) => candidate.number === Number.parseInt(parts[1] ?? '', 10));
  if (!issue) return null;
  return { repo, issue };
}

function pullByGlobalId(forge: Forge, key: string): { repo: Repo; pull: Pull } | null {
  const parts = key.split(':');
  const repo = repoById(forge, Number.parseInt(parts[0] ?? '', 10));
  if (!repo) return null;
  const pull = repo.pulls.find((candidate) => candidate.number === Number.parseInt(parts[1] ?? '', 10));
  if (!pull) return null;
  return { repo, pull };
}

function connection<T>(
  items: readonly T[],
  args: Record<string, unknown>,
  toNode: (item: T) => unknown,
): Record<string, unknown> {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : undefined;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  const start = after === null ? 0 : after + 1;
  const end = first === undefined ? items.length : Math.min(items.length, start + first);
  const page = items.slice(start, end);
  const edges = page.map((item, index) => ({
    cursor: encodeCursor(start + index),
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
function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const order = (orderBy as { field?: string; direction?: string } | undefined) ?? {};
  const direction = order.direction === 'ASC' ? 1 : -1;
  return [...issues].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return (a.createdAt - b.createdAt) * direction;
    return (a.number - b.number) * direction;
  });
}

function executeField(ctx: Ctx, parent: GqlObject | null, field: FieldSelection): unknown {
  const args = argMap(field, ctx.variables);
  const typename = parent?.__typename ?? 'Query';
  const data = parent?.data;

  // Root Query / Mutation.
  if (parent === null) {
    if (field.name === 'viewer') {
      return gqlObj('User', { login: ctx.forge.viewerLogin ?? ctx.owner, id: 1000 });
    }
    if (field.name === 'repository') {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = ctx.forge.getRepo(owner, name);
      if (!repo) return null;
      return gqlObj('Repository', { repo, owner });
    }
    if (field.name === 'node') {
      const id = typeof args.id === 'string' ? args.id : '';
      const decoded = decodeId(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoById(ctx.forge, Number.parseInt(decoded.key, 10));
        if (!repo) return null;
        return gqlObj('Repository', { repo, owner: ctx.forge.viewerLogin ?? '' });
      }
      if (decoded.kind === 'Issue') {
        const found = issueByGlobalId(ctx.forge, decoded.key);
        if (!found) return null;
        return gqlObj('Issue', { repo: found.repo, issue: found.issue });
      }
      if (decoded.kind === 'PullRequest') {
        const found = pullByGlobalId(ctx.forge, decoded.key);
        if (!found) return null;
        return gqlObj('PullRequest', { repo: found.repo, pull: found.pull });
      }
      return null;
    }
    if (field.name === '__type') {
      const name = typeof args.name === 'string' ? args.name : '';
      return gqlObj('__Type', { name });
    }
    if (field.name === 'createIssue') return resolveCreateIssue(ctx, args);
    if (field.name === 'closeIssue') return resolveCloseIssue(ctx, args);
    if (field.name === 'createPullRequest') return resolveCreatePullRequest(ctx, args);
    if (field.name === 'mergePullRequest') return resolveMergePullRequest(ctx, args);
    if (field.name === 'addComment') return resolveAddComment(ctx, args);
    ctx.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "Query".` });
    return null;
  }

  if (typename === 'User') {
    const user = data as { login: string; id: number };
    if (field.name === 'login') return user.login;
    if (field.name === 'id') return encodeId('User', String(user.id));
    if (field.name === 'databaseId') return user.id;
    if (field.name === 'name') return user.login;
    if (field.name === 'email') return `${user.login}@example.invalid`;
    ctx.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "User".` });
    return null;
  }

  if (typename === 'Repository') {
    const { repo, owner } = data as { repo: Repo; owner: string };
    switch (field.name) {
      case 'id':
        return encodeId('Repository', String(repo.id));
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${owner}/${repo.name}`;
      case 'owner':
        return gqlObj('User', { login: owner, id: 1000 });
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return null;
        return gqlObj('Ref', { name: repo.defaultBranch, target: tip });
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
        return gqlObj('Issue', { repo, issue });
      }
      case 'issues': {
        let issues = [...repo.issues];
        if (Array.isArray(args.states)) {
          const wanted = new Set(args.states.map((state) => String(state)));
          issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        issues = sortIssues(issues, args.orderBy);
        return connection(issues, args, (issue) => gqlObj('Issue', { repo, issue }));
      }
      case 'pullRequest': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const pull = repo.pulls.find((candidate) => candidate.number === number);
        if (!pull) return null;
        return gqlObj('PullRequest', { repo, pull });
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
        return connection(pulls, args, (pull) => gqlObj('PullRequest', { repo, pull }));
      }
      default:
        ctx.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "Repository".` });
        return null;
    }
  }

  if (typename === 'Issue') {
    const { repo, issue } = data as { repo: Repo; issue: Issue };
    switch (field.name) {
      case 'id':
        return encodeId('Issue', `${repo.id}:${issue.number}`);
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
        return { nodes: issue.labels.map((label) => gqlObj('Label', label)) };
      case 'comments':
        return connection(issue.comments, args, (comment) =>
          gqlObj('IssueComment', { repo, issue, comment }),
        );
      case 'repository':
        return gqlObj('Repository', { repo, owner: ctx.forge.viewerLogin ?? '' });
      case 'author':
        return gqlObj('User', { login: ctx.forge.viewerLogin ?? '', id: 1000 });
      case 'url':
        return `https://example.invalid/${ctx.forge.viewerLogin ?? ''}/${repo.name}/issues/${issue.number}`;
      default:
        ctx.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "Issue".` });
        return null;
    }
  }

  if (typename === 'PullRequest') {
    const { repo, pull } = data as { repo: Repo; pull: Pull };
    switch (field.name) {
      case 'id':
        return encodeId('PullRequest', `${repo.id}:${pull.number}`);
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
        const currentBase = ctx.forge.getRef(repo, `refs/heads/${pull.baseRef}`);
        if (!currentBase || !ctx.forge.getObject(repo, pull.headSha)) return 'UNKNOWN';
        const merged = ctx.forge.threeWayMerge(repo, currentBase, pull.headSha);
        return merged.conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'mergeCommit':
        return pull.mergeCommitSha ? gqlObj('Commit', { oid: pull.mergeCommitSha }) : null;
      case 'createdAt':
        return new Date().toISOString();
      case 'files': {
        const baseCommit = ctx.forge.getObject(repo, pull.baseSha);
        const headCommit = ctx.forge.getObject(repo, pull.headSha);
        if (!baseCommit || !headCommit) return connection([], args, (x: string) => x);
        const baseFiles = ctx.forge.flattenTree(repo, parseCommit(baseCommit.data).tree);
        const headFiles = ctx.forge.flattenTree(repo, parseCommit(headCommit.data).tree);
        const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
        const changed: string[] = [];
        for (const path of [...paths].sort()) {
          if (baseFiles.get(path)?.oid !== headFiles.get(path)?.oid) changed.push(path);
        }
        return connection(changed, args, (path) => gqlObj('PullRequestFile', { path }));
      }
      case 'repository':
        return gqlObj('Repository', { repo, owner: ctx.forge.viewerLogin ?? '' });
      case 'author':
        return gqlObj('User', { login: ctx.forge.viewerLogin ?? '', id: 1000 });
      case 'url':
        return `https://example.invalid/${ctx.forge.viewerLogin ?? ''}/${repo.name}/pull/${pull.number}`;
      default:
        ctx.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "PullRequest".` });
        return null;
    }
  }

  if (typename === 'Ref') {
    const ref = data as { name: string; target: string };
    if (field.name === 'name') return ref.name;
    if (field.name === 'target') return gqlObj('Commit', { oid: ref.target });
    ctx.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "Ref".` });
    return null;
  }

  if (typename === 'Commit') {
    const commit = data as { oid: string };
    if (field.name === 'oid') return commit.oid;
    if (field.name === 'id') return encodeId('Commit', commit.oid);
    ctx.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "Commit".` });
    return null;
  }

  if (typename === 'Label') {
    const label = data as { name: string; color: string };
    if (field.name === 'name') return label.name;
    if (field.name === 'color') return label.color;
    if (field.name === 'id') return encodeId('Label', label.name);
    ctx.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "Label".` });
    return null;
  }

  if (typename === 'IssueComment') {
    const { comment } = data as { comment: { id: number; body: string } };
    if (field.name === 'id') return encodeId('IssueComment', String(comment.id));
    if (field.name === 'databaseId') return comment.id;
    if (field.name === 'body') return comment.body;
    ctx.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "IssueComment".` });
    return null;
  }

  if (typename === 'PullRequestFile') {
    const file = data as { path: string };
    if (field.name === 'path') return file.path;
    ctx.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type "PullRequestFile".` });
    return null;
  }

  if (typename === '__Type') {
    const type = data as { name: string };
    return resolveIntrospection(type.name, field);
  }

  ctx.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type ${JSON.stringify(typename)}.` });
  return null;
}

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

function resolveIntrospection(name: string, field: FieldSelection): unknown {
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

function resolveCreateIssue(ctx: Ctx, args: Record<string, unknown>): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
  const decoded = decodeId(repositoryId);
  const repo = decoded?.kind === 'Repository' ? repoById(ctx.forge, Number.parseInt(decoded.key, 10)) : undefined;
  if (!repo) {
    ctx.errors.push({ message: 'repository not found' });
    return { issue: null };
  }
  const title = typeof input.title === 'string' ? input.title : '';
  const issue: Issue = {
    number: repo.issueSeq++,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    createdAt: ctx.forge.nextSeq(),
    comments: [],
  };
  repo.issues.push(issue);
  return gqlObj('CreateIssuePayload', { repo, issue });
}

function resolveCloseIssue(ctx: Ctx, args: Record<string, unknown>): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const issueId = typeof input.issueId === 'string' ? input.issueId : '';
  const decoded = decodeId(issueId);
  const found = decoded?.kind === 'Issue' ? issueByGlobalId(ctx.forge, decoded.key) : null;
  if (!found) {
    ctx.errors.push({ message: 'issue not found' });
    return { issue: null };
  }
  found.issue.state = 'closed';
  return gqlObj('CloseIssuePayload', { repo: found.repo, issue: found.issue });
}

function resolveCreatePullRequest(ctx: Ctx, args: Record<string, unknown>): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
  const decoded = decodeId(repositoryId);
  const repo = decoded?.kind === 'Repository' ? repoById(ctx.forge, Number.parseInt(decoded.key, 10)) : undefined;
  if (!repo) {
    ctx.errors.push({ message: 'repository not found' });
    return { pullRequest: null };
  }
  const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
  const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
  const headSha = ctx.forge.getRef(repo, `refs/heads/${headRef}`);
  const baseSha = ctx.forge.getRef(repo, `refs/heads/${baseRef}`);
  if (!headSha || !baseSha) {
    ctx.errors.push({ message: 'head or base branch does not exist' });
    return { pullRequest: null };
  }
  const pull: Pull = {
    number: repo.pullSeq++,
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
    createdAt: ctx.forge.nextSeq(),
  };
  repo.pulls.push(pull);
  return gqlObj('CreatePullRequestPayload', { repo, pull });
}

function resolveMergePullRequest(ctx: Ctx, args: Record<string, unknown>): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
  const decoded = decodeId(pullRequestId);
  const found = decoded?.kind === 'PullRequest' ? pullByGlobalId(ctx.forge, decoded.key) : null;
  if (!found) {
    ctx.errors.push({ message: 'pull request not found' });
    return { pullRequest: null };
  }
  const { repo, pull } = found;
  const mergeMethod = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE';
  if (pull.merged || pull.state === 'closed') {
    ctx.errors.push({ message: 'pull request is already merged or closed' });
    return gqlObj('MergePullRequestPayload', { repo, pull });
  }
  const baseRef = `refs/heads/${pull.baseRef}`;
  // Merge against the base branch as it stands now, not the tip recorded
  // when the pull request was opened.
  const currentBase = ctx.forge.getRef(repo, baseRef);
  if (!currentBase) {
    ctx.errors.push({ message: 'base branch does not exist' });
    return gqlObj('MergePullRequestPayload', { repo, pull });
  }
  const merged = ctx.forge.threeWayMerge(repo, currentBase, pull.headSha);
  if (merged.conflicts.length > 0) {
    ctx.errors.push({ message: `merge conflict in ${merged.conflicts.join(', ')}` });
    return gqlObj('MergePullRequestPayload', { repo, pull });
  }
  const message = mergeMethod === 'SQUASH' ? pull.title : `Merge pull request #${pull.number} from ${pull.headRef}`;
  const parents = mergeMethod === 'MERGE' ? [currentBase, pull.headSha] : [currentBase];
  const mergeCommit = ctx.forge.putObject(repo, 'commit', buildCommit({ tree: merged.treeOid, parents, message }));
  ctx.forge.setRef(repo, baseRef, mergeCommit);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = mergeCommit;
  return gqlObj('MergePullRequestPayload', { repo, pull });
}

function resolveAddComment(ctx: Ctx, args: Record<string, unknown>): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
  const decoded = decodeId(subjectId);
  if (decoded?.kind !== 'Issue') {
    ctx.errors.push({ message: 'subject is not an issue' });
    return { commentEdge: null };
  }
  const found = issueByGlobalId(ctx.forge, decoded.key);
  if (!found) {
    ctx.errors.push({ message: 'issue not found' });
    return { commentEdge: null };
  }
  const comment = { id: found.repo.commentSeq++, body: typeof input.body === 'string' ? input.body : '', createdAt: ctx.forge.nextSeq() };
  found.issue.comments.push(comment);
  return gqlObj('AddCommentPayload', { repo: found.repo, issue: found.issue, comment });
}

// Payload field resolution: a payload object exposes its named child.
function executePayloadField(ctx: Ctx, parent: GqlObject, field: FieldSelection): unknown {
  const data = parent.data as Record<string, unknown>;
  if (field.name === 'issue' && data.issue) return gqlObj('Issue', { repo: data.repo, issue: data.issue });
  if (field.name === 'pullRequest' && data.pull) return gqlObj('PullRequest', { repo: data.repo, pull: data.pull });
  if (field.name === 'commentEdge' && data.comment) {
    return gqlObj('IssueCommentEdge', { repo: data.repo, issue: data.issue, comment: data.comment });
  }
  if (field.name === 'clientMutationId') return null;
  ctx.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type ${JSON.stringify(parent.__typename)}.` });
  return null;
}

function executeSelections(
  ctx: Ctx,
  parent: GqlObject | null,
  selections: Selection[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment ${JSON.stringify(selection.name)}.` });
        continue;
      }
      Object.assign(out, executeSelections(ctx, parent, fragment.selections));
      continue;
    }
    if (selection.kind === 'inline') {
      const typename = parent?.__typename ?? 'Query';
      if (selection.typeCondition && selection.typeCondition !== typename) continue;
      Object.assign(out, executeSelections(ctx, parent, selection.selections));
      continue;
    }
    const key = selection.alias ?? selection.name;
    let value: unknown;
    if (parent !== null && parent.__typename.endsWith('Payload')) {
      value = executePayloadField(ctx, parent, selection);
    } else if (parent !== null && parent.__typename === 'IssueCommentEdge') {
      if (selection.name === 'node') {
        const data = parent.data as { repo: Repo; issue: Issue; comment: { id: number; body: string } };
        value = gqlObj('IssueComment', { repo: data.repo, issue: data.issue, comment: data.comment });
      } else {
        ctx.errors.push({ message: `Cannot query field ${JSON.stringify(selection.name)} on type "IssueCommentEdge".` });
        value = null;
      }
    } else {
      value = executeField(ctx, parent, selection);
    }
    if (value instanceof Object && value !== null && '__typename' in value && selection.selections.length > 0) {
      value = executeSelections(ctx, value as GqlObject, selection.selections);
    } else if (Array.isArray(value)) {
      // A list of objects (e.g. connection nodes handled inside the field).
      value = value.map((item) =>
        item instanceof Object && item !== null && '__typename' in item && selection.selections.length > 0
          ? executeSelections(ctx, item as GqlObject, selection.selections)
          : item,
      );
    } else if (
      value !== null &&
      typeof value === 'object' &&
      !Buffer.isBuffer(value) &&
      selection.selections.length > 0
    ) {
      // A plain object (e.g. a connection): recurse into its GqlObject leaves.
      value = resolveNested(ctx, value as Record<string, unknown>, selection.selections);
    }
    out[key] = value;
  }
  return out;
}

/** Recurse into a plain object (a connection), executing sub-selections on any GqlObject leaves. */
function resolveNested(
  ctx: Ctx,
  obj: Record<string, unknown>,
  selections: Selection[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value instanceof Object && value !== null && '__typename' in value) {
      const field = selections.find((s): s is FieldSelection => s.kind === 'field' && (s.alias ?? s.name) === key);
      out[key] = field && field.selections.length > 0 ? executeSelections(ctx, value as GqlObject, field.selections) : value;
    } else if (Array.isArray(value)) {
      const field = selections.find((s): s is FieldSelection => s.kind === 'field' && (s.alias ?? s.name) === key);
      out[key] = value.map((item) => {
        if (item instanceof Object && item !== null && '__typename' in item && field && field.selections.length > 0) {
          return executeSelections(ctx, item as GqlObject, field.selections);
        }
        if (item !== null && typeof item === 'object' && field && field.selections.length > 0) {
          return resolveNested(ctx, item as Record<string, unknown>, field.selections);
        }
        return item;
      });
    } else if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value)) {
      const field = selections.find((s): s is FieldSelection => s.kind === 'field' && (s.alias ?? s.name) === key);
      out[key] = field && field.selections.length > 0 ? resolveNested(ctx, value as Record<string, unknown>, field.selections) : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function executeOperation(
  forge: Forge,
  owner: string,
  operation: Operation,
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentDef>,
): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const ctx: Ctx = { forge, owner, errors: [], variables, fragments };
  const data = executeSelections(ctx, null, operation.selections);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

export function handleGraphQL(forge: Forge, req: HttpRequest): HttpResponse | null {
  if (req.pathname !== '/api/graphql') return null;
  if (req.method !== 'POST') return jsonResponse(405, { message: 'Method Not Allowed' });
  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return badRequest('request body is not valid JSON');
  }
  const owner = forge.viewerLogin ?? '';
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
      parsed = new Parser(query).parseDocument();
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
        vars[variable.name] = resolveValue(variable.defaultValue, vars);
      }
    }
    return executeOperation(forge, owner, operation, vars, parsed.fragments);
  };
  if (Array.isArray(body)) {
    return jsonResponse(200, body.map(runOne));
  }
  return jsonResponse(200, runOne(body));
}
