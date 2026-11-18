// mcp.ts — MCP over JSON-RPC 2.0 Streamable HTTP (POST /mcp): the modern
// 2026-07-28 era (`server/discover`, supportedVersions) and the legacy
// handshake (2025-11-25 and earlier: initialize + notifications/initialized),
// plus the six tools the suite requires. Answers are plain JSON; a
// notification (no id) is acknowledged with HTTP 202 and no body.

import { buildCommit } from './git.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';
import { jsonResponse, type HttpRequest, type HttpResponse } from './httputil.ts';

const SERVER_ID = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';

const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// The tool list is a fixed constant, so two tools/list answers are identical
// byte for byte.
const TOOL_DEFS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** A JSON-RPC success envelope for `id` carrying `result`. */
function rpcOk(id: unknown, result: unknown): HttpResponse {
  return jsonResponse(200, { jsonrpc: '2.0', id, result });
}

/** A JSON-RPC error envelope for `id` with `code` and `message`. */
function rpcFail(id: unknown, code: number, message: string, data?: unknown): HttpResponse {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return jsonResponse(200, { jsonrpc: '2.0', id, error });
}

/** Wrap a tool's return value as a text content block plus structured content. */
function toolOk(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
  };
}

/** A tool failure: a text block marked isError. */
function toolFail(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** The repository shape a tool returns. */
function serializeRepo(store: Forge, owner: string, repository: Repo): Record<string, unknown> {
  const login = store.viewerLogin ?? owner;
  return {
    id: repository.id,
    name: repository.name,
    full_name: `${login}/${repository.name}`,
    owner: { login, id: 1000, type: 'User' },
    private: repository.private,
    description: repository.description,
    default_branch: repository.defaultBranch,
  };
}

/** The issue shape a tool returns. */
function serializeIssue(store: Forge, owner: string, repository: Repo, ticket: Issue): Record<string, unknown> {
  const login = store.viewerLogin ?? owner;
  return {
    id: repository.id * 100000 + ticket.number,
    number: ticket.number,
    title: ticket.title,
    body: ticket.body,
    state: ticket.state,
    labels: ticket.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login, id: 1000, type: 'User' },
  };
}

/** The pull-request shape a tool returns. */
function serializePull(store: Forge, owner: string, repository: Repo, pr: Pull): Record<string, unknown> {
  const login = store.viewerLogin ?? owner;
  return {
    id: repository.id * 100000 + pr.number,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
  };
}

/** A tool argument as a string, or undefined when it is not one. */
function strArg(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A tool argument as a number (a numeric string counts), or undefined. */
function numArg(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** Run one tool; returns its result object (with isError on failure). */
function runTool(store: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOL_DEFS.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (!def) return toolFail(`unknown tool ${JSON.stringify(name)}`);
  // Missing required arguments are a tool error (the check accepts isError).
  for (const required of def.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolFail(`missing required argument ${JSON.stringify(required)}`);
    }
  }
  const owner = strArg(args.owner) ?? '';
  const repoName = strArg(args.repo) ?? '';
  switch (def.name) {
    case 'create_repo': {
      const repoNameArg = strArg(args.name) ?? '';
      if (store.getRepoByName(repoNameArg)) return toolFail(`repository ${JSON.stringify(repoNameArg)} already exists`);
      const repository = store.createRepo(
        repoNameArg,
        strArg(args.description) ?? '',
        typeof args.private === 'boolean' ? args.private : false,
      );
      return toolOk(serializeRepo(store, store.viewerLogin ?? '', repository));
    }
    case 'get_repo': {
      const repository = store.getRepo(owner, repoName);
      if (!repository) return toolFail('Not Found');
      return toolOk(serializeRepo(store, owner, repository));
    }
    case 'create_issue': {
      const repository = store.getRepo(owner, repoName);
      if (!repository) return toolFail('Not Found');
      const ticket: Issue = {
        number: repository.issueSeq++,
        title: strArg(args.title) ?? '',
        body: strArg(args.body) ?? '',
        state: 'open',
        labels: [],
        createdAt: store.nextSeq(),
        comments: [],
      };
      repository.issues.push(ticket);
      return toolOk(serializeIssue(store, owner, repository, ticket));
    }
    case 'list_issues': {
      const repository = store.getRepo(owner, repoName);
      if (!repository) return toolFail('Not Found');
      const state = strArg(args.state) ?? 'open';
      const tickets = repository.issues.filter((ticket) => state === 'all' || ticket.state === state);
      return toolOk(tickets.map((ticket) => serializeIssue(store, owner, repository, ticket)));
    }
    case 'create_pull_request': {
      const repository = store.getRepo(owner, repoName);
      if (!repository) return toolFail('Not Found');
      const head = strArg(args.head) ?? '';
      const base = strArg(args.base) ?? '';
      const headSha = store.getRef(repository, `refs/heads/${head}`);
      const baseSha = store.getRef(repository, `refs/heads/${base}`);
      if (!headSha || !baseSha) return toolFail('head or base branch does not exist');
      const pr: Pull = {
        number: repository.pullSeq++,
        title: strArg(args.title) ?? '',
        body: strArg(args.body) ?? '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: store.nextSeq(),
      };
      repository.pulls.push(pr);
      return toolOk(serializePull(store, owner, repository, pr));
    }
    case 'merge_pull_request': {
      const repository = store.getRepo(owner, repoName);
      if (!repository) return toolFail('Not Found');
      const number = numArg(args.pull_number);
      if (number === undefined) return toolFail('pull_number is required');
      const pr = repository.pulls.find((candidate) => candidate.number === number);
      if (!pr) return toolFail('Not Found');
      if (pr.merged || pr.state === 'closed') return toolFail('pull request is already merged or closed');
      const baseRef = `refs/heads/${pr.baseRef}`;
      // Merge against the base branch as it stands now.
      const currentBase = store.getRef(repository, baseRef);
      if (!currentBase) return toolFail('base branch does not exist');
      const merged = store.threeWayMerge(repository, currentBase, pr.headSha);
      if (merged.conflicts.length > 0) return toolFail(`merge conflict in ${merged.conflicts.join(', ')}`);
      const mergeCommit = store.putObject(
        repository,
        'commit',
        buildCommit({ tree: merged.treeOid, parents: [currentBase], message: pr.title }),
      );
      store.setRef(repository, baseRef, mergeCommit);
      pr.merged = true;
      pr.state = 'closed';
      pr.mergedAt = new Date().toISOString();
      pr.mergeCommitSha = mergeCommit;
      return toolOk({ ...serializePull(store, owner, repository, pr), sha: mergeCommit });
    }
    default:
      return toolFail(`unknown tool ${JSON.stringify(name)}`);
  }
}

export function handleMcp(store: Forge, req: HttpRequest): HttpResponse | null {
  if (req.pathname !== '/mcp') return null;
  if (req.method === 'DELETE') {
    // A legacy session close: acknowledge and forget.
    return { status: 204, headers: {}, body: Buffer.alloc(0) };
  }
  if (req.method !== 'POST') {
    return jsonResponse(405, { message: 'Method Not Allowed' });
  }
  const protocolVersion = req.headers.get('mcp-protocol-version');
  // A body that is not JSON: -32700. The 2026-07-28 transport answers HTTP
  // 400; earlier revisions answer HTTP 200.
  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    const error = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
    return jsonResponse(protocolVersion === LATEST_VERSION ? 400 : 200, error);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return rpcFail(null, -32600, 'Invalid Request');
  }
  const record = body as Record<string, unknown>;
  const id = (record.id ?? null) as string | number | null;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;

  // A notification (no id) is acknowledged with HTTP 202 and no body.
  if (record.id === undefined) {
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }

  if (method === 'server/discover') {
    // The client declares its revision in the header and in _meta. An
    // unsupported revision is -32022 with the versions we do support.
    const declared =
      protocolVersion ??
      (typeof (params._meta as Record<string, unknown> | undefined)?.protocolVersion === 'string'
        ? ((params._meta as Record<string, unknown>).protocolVersion as string)
        : undefined) ??
      (typeof (params._meta as Record<string, unknown> | undefined)?.['io.modelcontextprotocol/protocolVersion'] ===
      'string'
        ? ((params._meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'] as string)
        : undefined);
    if (declared !== undefined && !PROTOCOL_VERSIONS.includes(declared)) {
      return rpcFail(id, -32022, `Unsupported protocol version ${JSON.stringify(declared)}`, {
        supported: PROTOCOL_VERSIONS,
      });
    }
    const serverInfo = { name: SERVER_ID, version: SERVER_VERSION };
    return rpcOk(id, {
      resultType: 'discover',
      supportedVersions: PROTOCOL_VERSIONS,
      capabilities: { tools: {} },
      instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests and git smart HTTP.',
      serverInfo,
      protocolVersion: LATEST_VERSION,
      _meta: {
        'io.modelcontextprotocol/serverInfo': serverInfo,
        'io.modelcontextprotocol/protocolVersion': LATEST_VERSION,
      },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-11-25';
    const response = rpcOk(id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_ID, version: SERVER_VERSION },
    });
    // A legacy session id, handed out on initialize.
    return { ...response, headers: { ...response.headers, 'Mcp-Session-Id': `session-${Date.now().toString(36)}` } };
  }

  if (method === 'ping') {
    return rpcOk(id, {});
  }

  if (method === 'tools/list') {
    return rpcOk(id, { tools: TOOL_DEFS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!name) return rpcFail(id, -32602, 'Invalid params: tools/call needs a name');
    // An unknown tool is a JSON-RPC error, never an HTTP 500.
    const known = TOOL_DEFS.some((tool) => tool.name.toLowerCase() === name.toLowerCase());
    if (!known) return rpcFail(id, -32601, `Method not found: unknown tool ${JSON.stringify(name)}`);
    const result = runTool(store, name, args);
    return rpcOk(id, result);
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }

  return rpcFail(id, -32601, `Method not found: ${JSON.stringify(method)}`);
}
