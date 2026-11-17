// mcp.ts — MCP over JSON-RPC 2.0 Streamable HTTP (POST /mcp): the modern
// 2026-07-28 era (`server/discover`, supportedVersions) and the legacy
// handshake (2025-11-25 and earlier: initialize + notifications/initialized),
// plus the six tools the suite requires. Answers are plain JSON; a
// notification (no id) is acknowledged with HTTP 202 and no body.

import { buildCommit } from './git.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';
import { jsonResponse, type HttpRequest, type HttpResponse } from './httputil.ts';

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MODERN_VERSION = '2026-07-28';

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
const TOOLS: ToolDef[] = [
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

function rpcResult(id: unknown, result: unknown): HttpResponse {
  return jsonResponse(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): HttpResponse {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return jsonResponse(200, { jsonrpc: '2.0', id, error });
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function repoJson(forge: Forge, owner: string, repo: Repo): Record<string, unknown> {
  const login = forge.viewerLogin ?? owner;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(forge: Forge, owner: string, repo: Repo, issue: Issue): Record<string, unknown> {
  const login = forge.viewerLogin ?? owner;
  return {
    id: repo.id * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login, id: 1000, type: 'User' },
  };
}

function pullJson(forge: Forge, owner: string, repo: Repo, pull: Pull): Record<string, unknown> {
  const login = forge.viewerLogin ?? owner;
  return {
    id: repo.id * 100000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** Run one tool; returns its result object (with isError on failure). */
function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (!tool) return toolError(`unknown tool ${JSON.stringify(name)}`);
  // Missing required arguments are a tool error (the check accepts isError).
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`missing required argument ${JSON.stringify(required)}`);
    }
  }
  const owner = asString(args.owner) ?? '';
  const repoName = asString(args.repo) ?? '';
  switch (tool.name) {
    case 'create_repo': {
      const repoNameArg = asString(args.name) ?? '';
      if (forge.getRepoByName(repoNameArg)) return toolError(`repository ${JSON.stringify(repoNameArg)} already exists`);
      const repo = forge.createRepo(
        repoNameArg,
        asString(args.description) ?? '',
        typeof args.private === 'boolean' ? args.private : false,
      );
      return toolResult(repoJson(forge, forge.viewerLogin ?? '', repo));
    }
    case 'get_repo': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return toolError('Not Found');
      return toolResult(repoJson(forge, owner, repo));
    }
    case 'create_issue': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return toolError('Not Found');
      const issue: Issue = {
        number: repo.issueSeq++,
        title: asString(args.title) ?? '',
        body: asString(args.body) ?? '',
        state: 'open',
        labels: [],
        createdAt: forge.nextSeq(),
        comments: [],
      };
      repo.issues.push(issue);
      return toolResult(issueJson(forge, owner, repo, issue));
    }
    case 'list_issues': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return toolError('Not Found');
      const state = asString(args.state) ?? 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return toolResult(issues.map((issue) => issueJson(forge, owner, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return toolError('Not Found');
      const head = asString(args.head) ?? '';
      const base = asString(args.base) ?? '';
      const headSha = forge.getRef(repo, `refs/heads/${head}`);
      const baseSha = forge.getRef(repo, `refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError('head or base branch does not exist');
      const pull: Pull = {
        number: repo.pullSeq++,
        title: asString(args.title) ?? '',
        body: asString(args.body) ?? '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: forge.nextSeq(),
      };
      repo.pulls.push(pull);
      return toolResult(pullJson(forge, owner, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return toolError('Not Found');
      const number = asNumber(args.pull_number);
      if (number === undefined) return toolError('pull_number is required');
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (!pull) return toolError('Not Found');
      if (pull.merged || pull.state === 'closed') return toolError('pull request is already merged or closed');
      const baseRef = `refs/heads/${pull.baseRef}`;
      // Merge against the base branch as it stands now.
      const currentBase = forge.getRef(repo, baseRef);
      if (!currentBase) return toolError('base branch does not exist');
      const merged = forge.threeWayMerge(repo, currentBase, pull.headSha);
      if (merged.conflicts.length > 0) return toolError(`merge conflict in ${merged.conflicts.join(', ')}`);
      const mergeCommit = forge.putObject(
        repo,
        'commit',
        buildCommit({ tree: merged.treeOid, parents: [currentBase], message: pull.title }),
      );
      forge.setRef(repo, baseRef, mergeCommit);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = mergeCommit;
      return toolResult({ ...pullJson(forge, owner, repo, pull), sha: mergeCommit });
    }
    default:
      return toolError(`unknown tool ${JSON.stringify(name)}`);
  }
}

export function handleMcp(forge: Forge, req: HttpRequest): HttpResponse | null {
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
    return jsonResponse(protocolVersion === MODERN_VERSION ? 400 : 200, error);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid Request');
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
    if (declared !== undefined && !SUPPORTED_VERSIONS.includes(declared)) {
      return rpcError(id, -32022, `Unsupported protocol version ${JSON.stringify(declared)}`, {
        supported: SUPPORTED_VERSIONS,
      });
    }
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return rpcResult(id, {
      resultType: 'discover',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests and git smart HTTP.',
      serverInfo,
      protocolVersion: MODERN_VERSION,
      _meta: {
        'io.modelcontextprotocol/serverInfo': serverInfo,
        'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
      },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    const response = rpcResult(id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    // A legacy session id, handed out on initialize.
    return { ...response, headers: { ...response.headers, 'Mcp-Session-Id': `session-${Date.now().toString(36)}` } };
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!name) return rpcError(id, -32602, 'Invalid params: tools/call needs a name');
    // An unknown tool is a JSON-RPC error, never an HTTP 500.
    const known = TOOLS.some((tool) => tool.name.toLowerCase() === name.toLowerCase());
    if (!known) return rpcError(id, -32601, `Method not found: unknown tool ${JSON.stringify(name)}`);
    const result = callTool(forge, name, args);
    return rpcResult(id, result);
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }

  return rpcError(id, -32601, `Method not found: ${JSON.stringify(method)}`);
}
