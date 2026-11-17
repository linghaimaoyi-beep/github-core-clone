// rest.ts — REST v3 (`/api/v3`): repositories, branches, commits, the contents
// API, labels, issues, comments and pull requests. All responses are JSON
// (never HTML) and carry X-GitHub-Request-Id; unknown routes are JSON 404s.

import { buildCommit, isObjectId, parseCommit, parseTree, ZERO_OID } from './git.ts';
import type { Forge, Issue, Label, Pull, Repo } from './store.ts';
import {
  badRequest,
  binaryResponse,
  jsonResponse,
  notFound,
  unprocessable,
  type HttpRequest,
  type HttpResponse,
} from './httputil.ts';

function isoNow(): string {
  return new Date().toISOString();
}

function ownerLogin(forge: Forge, owner: string): string {
  return forge.viewerLogin ?? owner;
}

function repoJson(forge: Forge, owner: string, repo: Repo): Record<string, unknown> {
  const login = ownerLogin(forge, owner);
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${login}/${repo.name}`,
    url: `/api/v3/repos/${login}/${repo.name}`,
    git_url: `git://example.invalid/${login}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${login}/${repo.name}.git`,
    clone_url: `https://example.invalid/${login}/${repo.name}.git`,
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    watchers_count: 0,
    size: 0,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    license: null,
    created_at: isoNow(),
    updated_at: isoNow(),
    pushed_at: isoNow(),
  };
}

function issueJson(forge: Forge, owner: string, repo: Repo, issue: Issue): Record<string, unknown> {
  const login = ownerLogin(forge, owner);
  return {
    id: repo.id * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ id: 1, name: label.name, color: label.color, url: `/api/v3/repos/${login}/${repo.name}/labels/${encodeURIComponent(label.name)}`, description: '' })),
    user: { login, id: 1000, type: 'User' },
    created_at: isoNow(),
    updated_at: isoNow(),
    closed_at: issue.state === 'closed' ? isoNow() : null,
    url: `/api/v3/repos/${login}/${repo.name}/issues/${issue.number}`,
    html_url: `https://example.invalid/${login}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
    comments_url: `/api/v3/repos/${login}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function pullJson(forge: Forge, owner: string, repo: Repo, pull: Pull): Record<string, unknown> {
  const login = ownerLogin(forge, owner);
  return {
    id: repo.id * 100000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${login}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login, id: 1000, type: 'User' },
    created_at: isoNow(),
    updated_at: isoNow(),
    closed_at: pull.state === 'closed' ? isoNow() : null,
    url: `/api/v3/repos/${login}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${login}/${repo.name}/pull/${pull.number}`,
  };
}

/** Read and parse a JSON body; null when the body is empty, an error response when malformed. */
function readJsonBody(req: HttpRequest): { ok: true; value: Record<string, unknown> } | { ok: false; response: HttpResponse } {
  if (req.body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(req.body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, response: badRequest('request body must be a JSON object') };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: badRequest('request body is not valid JSON') };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Paginate `items` by `page`/`per_page`; returns the page and a Link header value (or ''). */
function paginate<T>(
  items: readonly T[],
  req: HttpRequest,
  defaultPerPage = 30,
): { page: T[]; link: string } {
  const perPageRaw = Number.parseInt(req.search.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : defaultPerPage;
  const pageRaw = Number.parseInt(req.search.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link = '';
  const host = req.headers.get('host') ?? '127.0.0.1';
  const base = `http://${host}${req.pathname}`;
  const params = new URLSearchParams(req.search);
  if (start + perPage < items.length) {
    params.set('per_page', String(perPage));
    params.set('page', String(page + 1));
    link = `<${base}?${params.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function withLink(response: HttpResponse, link: string): HttpResponse {
  if (!link) return response;
  return { ...response, headers: { ...response.headers, Link: link } };
}

/** A repo lookup for /repos/{owner}/{name}: 404 when the owner is foreign or the repo is absent. */
function findRepo(forge: Forge, owner: string, name: string): Repo | null {
  return forge.getRepo(owner, name) ?? null;
}

/** A simple line diff: additions/deletions by multiset difference of lines. */
function diffLines(before: string, after: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const beforeCount = count(before);
  const afterCount = count(after);
  let additions = 0;
  for (const [line, n] of afterCount) additions += Math.max(0, n - (beforeCount.get(line) ?? 0));
  let deletions = 0;
  for (const [line, n] of beforeCount) deletions += Math.max(0, n - (afterCount.get(line) ?? 0));
  return { additions, deletions };
}

// -------------------------------------------------------------------------------------------
// routing
// -------------------------------------------------------------------------------------------

export function handleRest(forge: Forge, req: HttpRequest): HttpResponse | null {
  const path = req.pathname;
  if (!path.startsWith('/api/v3')) return null;
  const rest = path.slice('/api/v3'.length);
  const segments = rest.split('/').filter((segment) => segment.length > 0);
  const method = req.method;

  // GET /api/v3/ — the API root.
  if (segments.length === 0 && method === 'GET') {
    return jsonResponse(
      200,
      {
        current_user_url: '/api/v3/user',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}',
        commit_search_url: '/api/v3/search/commits?q={query}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/user/followers',
        following_url: '/api/v3/user/following{/target}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: '/api/v3/hub',
        issue_search_url: '/api/v3/search/issues?q={query}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys',
        labels_url: '/api/v3/repos/{owner}/{repo}/labels{/name}',
        notifications_url: '/api/v3/notifications',
        organization_repositories_url: '/api/v3/orgs/{org}/repos',
        organization_url: '/api/v3/orgs/{org}',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}',
        current_user_repositories_url: '/api/v3/user/repos',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        topic_search_url: '/api/v3/search/topics?q={query}',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/user/orgs',
        user_repositories_url: '/api/v3/users/{user}/repos',
        user_search_url: '/api/v3/search/users?q={query}',
      },
      { 'X-OAuth-Scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    return jsonResponse(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // GET /api/v3/user — the authenticated user (the token's login).
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    const login = forge.viewerLogin ?? '';
    return jsonResponse(200, {
      login,
      id: 1000,
      type: 'User',
      name: login,
      email: `${login}@example.invalid`,
      url: '/api/v3/user',
      html_url: `https://example.invalid/${login}`,
    });
  }

  // /user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const parsed = readJsonBody(req);
      if (!parsed.ok) return parsed.response;
      const body = parsed.value;
      const name = asString(body.name);
      if (!name) return unprocessable('name is required');
      if (forge.getRepoByName(name)) return unprocessable('name already exists on this account');
      const repo = forge.createRepo(name, asString(body.description) ?? '', asBoolean(body.private) ?? false);
      return jsonResponse(201, repoJson(forge, forge.viewerLogin ?? '', repo));
    }
    if (method === 'GET') {
      const repos = forge.listRepos();
      const { page, link } = paginate(repos, req);
      return withLink(jsonResponse(200, page.map((repo) => repoJson(forge, forge.viewerLogin ?? '', repo))), link);
    }
    return null;
  }

  // /repos/{owner}/{repo}...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1]!;
    const repoName = segments[2]!;
    const repo = findRepo(forge, owner, repoName);
    if (!repo) return notFound('Not Found');
    const login = ownerLogin(forge, owner);
    const rest = segments.slice(3);

    // GET / PATCH / DELETE /repos/{owner}/{repo}
    if (rest.length === 0) {
      if (method === 'GET') return jsonResponse(200, repoJson(forge, owner, repo));
      if (method === 'PATCH') {
        const parsed = readJsonBody(req);
        if (!parsed.ok) return parsed.response;
        const description = asString(parsed.value.description);
        if (description !== undefined) repo.description = description;
        const isPrivate = asBoolean(parsed.value.private);
        if (isPrivate !== undefined) repo.private = isPrivate;
        return jsonResponse(200, repoJson(forge, owner, repo));
      }
      if (method === 'DELETE') {
        forge.deleteRepo(repoName);
        return { status: 204, headers: { 'X-GitHub-Request-Id': jsonResponse(204, {}).headers['X-GitHub-Request-Id']! }, body: Buffer.alloc(0) };
      }
      return null;
    }

    // GET /repos/{owner}/{repo}/branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const branches = forge.listRefs(repo)
        .filter((ref) => ref.name.startsWith('refs/heads/'))
        .map((ref) => ({
          name: ref.name.slice('refs/heads/'.length),
          commit: { sha: ref.oid, url: `/api/v3/repos/${login}/${repoName}/commits/${ref.oid}` },
          protected: false,
        }));
      return jsonResponse(200, branches);
    }

    // GET /repos/{owner}/{repo}/commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const shaParam = req.search.get('sha');
      let tip: string | undefined;
      if (shaParam) {
        if (shaParam.startsWith('refs/')) tip = forge.getRef(repo, shaParam);
        else if (forge.getRef(repo, `refs/heads/${shaParam}`)) tip = forge.getRef(repo, `refs/heads/${shaParam}`);
        else if (forge.getRef(repo, `refs/tags/${shaParam}`)) tip = forge.getRef(repo, `refs/tags/${shaParam}`);
        else if (isObjectId(shaParam)) tip = shaParam;
        else tip = undefined;
      } else {
        tip = forge.headOid(repo);
      }
      if (!tip || tip === ZERO_OID) return jsonResponse(200, []);
      const history = forge.commitHistory(repo, tip);
      const entries = history.map((oid) => {
        const object = forge.getObject(repo, oid)!;
        const commit = parseCommit(object.data);
        return {
          sha: oid,
          commit: { message: commit.message, author: { name: 'Conformance', email: 'conformance@make.fun', date: isoNow() }, committer: { name: 'Conformance', email: 'conformance@make.fun', date: isoNow() } },
          author: { login, id: 1000, type: 'User' },
          url: `/api/v3/repos/${login}/${repoName}/commits/${oid}`,
        };
      });
      const { page, link } = paginate(entries, req);
      return withLink(jsonResponse(200, page), link);
    }

    // POST /repos/{owner}/{repo}/git/refs  (create a branch)
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const parsed = readJsonBody(req);
      if (!parsed.ok) return parsed.response;
      const ref = asString(parsed.value.ref);
      const sha = asString(parsed.value.sha);
      if (!ref || !sha || !isObjectId(sha)) return unprocessable('ref and sha are required');
      if (!ref.startsWith('refs/')) return unprocessable('ref must start with refs/');
      if (forge.getRef(repo, ref)) return unprocessable('Reference already exists');
      if (!forge.getObject(repo, sha)) return unprocessable('Object does not exist');
      forge.setRef(repo, ref, sha);
      return jsonResponse(201, { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${login}/${repoName}/git/commits/${sha}` }, url: `/api/v3/repos/${login}/${repoName}/git/refs/${ref}` });
    }

    // GET /repos/{owner}/{repo}/git/refs (list all refs)
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'GET') {
      const refs = forge.listRefs(repo).map((ref) => ({
        ref: ref.name,
        object: { sha: ref.oid, type: 'commit', url: `/api/v3/repos/${login}/${repoName}/git/commits/${ref.oid}` },
        url: `/api/v3/repos/${login}/${repoName}/git/refs/${ref.name}`,
      }));
      return jsonResponse(200, refs);
    }

    // GET /repos/{owner}/{repo}/git/refs/{ref...} — a single ref.
    if (rest.length >= 3 && rest[0] === 'git' && rest[1] === 'refs' && method === 'GET') {
      const refName = `refs/${rest.slice(2).join('/')}`;
      const oid = forge.getRef(repo, refName);
      if (!oid) return notFound('Not Found');
      return jsonResponse(200, {
        ref: refName,
        object: { sha: oid, type: 'commit', url: `/api/v3/repos/${login}/${repoName}/git/commits/${oid}` },
        url: `/api/v3/repos/${login}/${repoName}/git/refs/${refName}`,
      });
    }

    // GET /repos/{owner}/{repo}/branches/{branch} — a single branch.
    if (rest.length === 2 && rest[0] === 'branches' && method === 'GET') {
      const branch = rest[1]!;
      const oid = forge.getRef(repo, `refs/heads/${branch}`);
      if (!oid) return notFound('Not Found');
      return jsonResponse(200, {
        name: branch,
        commit: { sha: oid, url: `/api/v3/repos/${login}/${repoName}/commits/${oid}` },
        protected: false,
      });
    }

    // /repos/{owner}/{repo}/contents/{path...}
    if (rest.length >= 2 && rest[0] === 'contents') {
      return handleContents(forge, req, owner, repoName, repo, rest.slice(1).join('/'));
    }

    // /repos/{owner}/{repo}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'POST') {
        const parsed = readJsonBody(req);
        if (!parsed.ok) return parsed.response;
        const name = asString(parsed.value.name);
        const color = asString(parsed.value.color);
        if (!name || !color) return unprocessable('name and color are required');
        if (repo.labels.has(name)) return unprocessable('Label already exists');
        const label: Label = { name, color };
        repo.labels.set(name, label);
        return jsonResponse(201, { id: repo.labels.size, name, color, url: `/api/v3/repos/${login}/${repoName}/labels/${encodeURIComponent(name)}`, description: '' });
      }
      if (method === 'GET') {
        const labels = [...repo.labels.values()].map((label) => ({
          id: 1,
          name: label.name,
          color: label.color,
          url: `/api/v3/repos/${login}/${repoName}/labels/${encodeURIComponent(label.name)}`,
          description: '',
        }));
        return jsonResponse(200, labels);
      }
      return null;
    }

    // /repos/{owner}/{repo}/issues...
    if (rest[0] === 'issues') {
      return handleIssues(forge, req, owner, repoName, repo, rest.slice(1));
    }

    // /repos/{owner}/{repo}/pulls...
    if (rest[0] === 'pulls') {
      return handlePulls(forge, req, owner, repoName, repo, rest.slice(1));
    }

    return notFound('Not Found');
  }

  return null;
}

// -------------------------------------------------------------------------------------------
// contents API
// -------------------------------------------------------------------------------------------

/** Resolve a ref query (?ref= or body.branch) to a commit id. */
function resolveContentRef(forge: Forge, repo: Repo, ref: string | undefined): string | undefined {
  if (!ref) return forge.headOid(repo);
  if (forge.getRef(repo, ref)) return forge.getRef(repo, ref);
  if (forge.getRef(repo, `refs/heads/${ref}`)) return forge.getRef(repo, `refs/heads/${ref}`);
  if (forge.getRef(repo, `refs/tags/${ref}`)) return forge.getRef(repo, `refs/tags/${ref}`);
  if (isObjectId(ref) && forge.getObject(repo, ref)) return ref;
  return undefined;
}

function handleContents(
  forge: Forge,
  req: HttpRequest,
  owner: string,
  repoName: string,
  repo: Repo,
  path: string,
): HttpResponse {
  const login = ownerLogin(forge, owner);
  const method = req.method;
  const decodedPath = decodeURIComponent(path);

  if (method === 'GET') {
    const tip = resolveContentRef(forge, repo, req.search.get('ref') ?? undefined);
    if (!tip || tip === ZERO_OID) return notFound('Not Found');
    const file = forge.readFileAt(repo, tip, decodedPath);
    if (file) {
      return jsonResponse(200, {
        type: 'file',
        encoding: 'base64',
        size: file.data.length,
        name: decodedPath.split('/').pop() ?? decodedPath,
        path: decodedPath,
        content: file.data.toString('base64'),
        sha: file.oid,
        url: `/api/v3/repos/${login}/${repoName}/contents/${path}`,
        html_url: `https://example.invalid/${login}/${repoName}/blob/${repo.defaultBranch}/${path}`,
        download_url: `https://example.invalid/${login}/${repoName}/raw/${repo.defaultBranch}/${path}`,
      });
    }
    const entries = forge.listDirAt(repo, tip, decodedPath);
    if (entries) {
      return jsonResponse(
        200,
        entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: decodedPath ? `${decodedPath}/${entry.name}` : entry.name,
          sha: entry.oid,
          size: entry.mode === '40000' ? 0 : (forge.getObject(repo, entry.oid)?.data.length ?? 0),
          url: `/api/v3/repos/${login}/${repoName}/contents/${decodedPath ? `${decodedPath}/` : ''}${entry.name}`,
          html_url: `https://example.invalid/${login}/${repoName}/tree/${repo.defaultBranch}/${decodedPath ? `${decodedPath}/` : ''}${entry.name}`,
          download_url: entry.mode === '40000' ? null : `https://example.invalid/${login}/${repoName}/raw/${repo.defaultBranch}/${decodedPath ? `${decodedPath}/` : ''}${entry.name}`,
        })),
      );
    }
    return notFound('Not Found');
  }

  if (method === 'PUT') {
    const parsed = readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const message = asString(body.message) ?? `Update ${decodedPath}`;
    const contentB64 = asString(body.content);
    if (contentB64 === undefined) return unprocessable('content is required');
    let data: Buffer;
    try {
      data = Buffer.from(contentB64, 'base64');
    } catch {
      return badRequest('content is not valid base64');
    }
    const branchName = asString(body.branch) ?? req.search.get('ref') ?? repo.defaultBranch;
    const branchRef = branchName.startsWith('refs/') ? branchName : `refs/heads/${branchName}`;
    const tip = forge.getRef(repo, branchRef);
    const existing = tip ? forge.readFileAt(repo, tip, decodedPath) : null;
    const givenSha = asString(body.sha);
    if (givenSha && existing && givenSha !== existing.oid) {
      return jsonResponse(409, { message: 'sha does not match the current file' });
    }
    const isUpdate = existing !== null;
    const commitOid = forge.commitFile(repo, branchRef, decodedPath, data, message);
    const blobOid = forge.readFileAt(repo, commitOid, decodedPath)!.oid;
    return jsonResponse(isUpdate ? 200 : 201, {
      content: {
        name: decodedPath.split('/').pop() ?? decodedPath,
        path: decodedPath,
        sha: blobOid,
        size: data.length,
        url: `/api/v3/repos/${login}/${repoName}/contents/${path}`,
        html_url: `https://example.invalid/${login}/${repoName}/blob/${repo.defaultBranch}/${path}`,
        download_url: `https://example.invalid/${login}/${repoName}/raw/${repo.defaultBranch}/${path}`,
        type: 'file',
        encoding: 'base64',
      },
      commit: {
        sha: commitOid,
        message,
        author: { name: 'Conformance', email: 'conformance@make.fun', date: isoNow() },
        committer: { name: 'Conformance', email: 'conformance@make.fun', date: isoNow() },
      },
    });
  }

  if (method === 'DELETE') {
    const parsed = readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const message = asString(body.message) ?? `Delete ${decodedPath}`;
    const branchName = asString(body.branch) ?? req.search.get('ref') ?? repo.defaultBranch;
    const branchRef = branchName.startsWith('refs/') ? branchName : `refs/heads/${branchName}`;
    const tip = forge.getRef(repo, branchRef);
    const existing = tip ? forge.readFileAt(repo, tip, decodedPath) : null;
    if (!existing) return notFound('Not Found');
    const givenSha = asString(body.sha);
    if (givenSha && givenSha !== existing.oid) {
      return jsonResponse(409, { message: 'sha does not match the current file' });
    }
    const commitOid = forge.commitDeleteFile(repo, branchRef, decodedPath, message);
    return jsonResponse(200, {
      commit: {
        sha: commitOid,
        message,
        author: { name: 'Conformance', email: 'conformance@make.fun', date: isoNow() },
        committer: { name: 'Conformance', email: 'conformance@make.fun', date: isoNow() },
      },
    });
  }

  return notFound('Not Found');
}

// -------------------------------------------------------------------------------------------
// issues
// -------------------------------------------------------------------------------------------

function handleIssues(
  forge: Forge,
  req: HttpRequest,
  owner: string,
  repoName: string,
  repo: Repo,
  rest: string[],
): HttpResponse {
  const login = ownerLogin(forge, owner);
  const method = req.method;

  // /issues — create or list
  if (rest.length === 0) {
    if (method === 'POST') {
      const parsed = readJsonBody(req);
      if (!parsed.ok) return parsed.response;
      const body = parsed.value;
      const title = asString(body.title);
      if (!title) return unprocessable('title is required');
      const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      const labels: Label[] = [];
      for (const name of labelNames) {
        const label = repo.labels.get(name);
        if (!label) return unprocessable(`Label ${JSON.stringify(name)} does not exist`);
        labels.push(label);
      }
      const issue: Issue = {
        number: repo.issueSeq++,
        title,
        body: asString(body.body) ?? '',
        state: 'open',
        labels,
        createdAt: forge.nextSeq(),
        comments: [],
      };
      repo.issues.push(issue);
      return jsonResponse(201, issueJson(forge, owner, repo, issue));
    }
    if (method === 'GET') {
      const state = req.search.get('state') ?? 'open';
      const sort = req.search.get('sort') ?? 'created';
      const direction = req.search.get('direction') ?? 'desc';
      let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      if (sort === 'created') {
        issues = [...issues].sort((a, b) => (direction === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
      }
      const { page, link } = paginate(issues, req);
      const out = page.map((issue) => issueJson(forge, owner, repo, issue));
      return withLink(jsonResponse(200, out), link);
    }
    return notFound('Not Found');
  }

  const number = Number.parseInt(rest[0] ?? '', 10);
  if (!Number.isFinite(number)) return notFound('Not Found');
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (!issue) return notFound('Not Found');

  // /issues/{n}
  if (rest.length === 1) {
    if (method === 'GET') return jsonResponse(200, issueJson(forge, owner, repo, issue));
    if (method === 'PATCH') {
      const parsed = readJsonBody(req);
      if (!parsed.ok) return parsed.response;
      const body = parsed.value;
      const state = asString(body.state);
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = asString(body.title);
      if (title !== undefined) issue.title = title;
      const text = asString(body.body);
      if (text !== undefined) issue.body = text;
      return jsonResponse(200, issueJson(forge, owner, repo, issue));
    }
    return notFound('Not Found');
  }

  // /issues/{n}/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const parsed = readJsonBody(req);
      if (!parsed.ok) return parsed.response;
      const text = asString(parsed.value.body);
      if (!text) return unprocessable('body is required');
      const comment: Comment = { id: repo.commentSeq++, body: text, createdAt: forge.nextSeq() };
      issue.comments.push(comment);
      return jsonResponse(201, {
        id: comment.id,
        body: comment.body,
        user: { login, id: 1000, type: 'User' },
        created_at: isoNow(),
        updated_at: isoNow(),
        url: `/api/v3/repos/${login}/${repoName}/issues/comments/${comment.id}`,
        html_url: `https://example.invalid/${login}/${repoName}/issues/${issue.number}#issuecomment-${comment.id}`,
      });
    }
    if (method === 'GET') {
      const { page, link } = paginate(issue.comments, req);
      const out = page.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login, id: 1000, type: 'User' },
        created_at: isoNow(),
        updated_at: isoNow(),
        url: `/api/v3/repos/${login}/${repoName}/issues/comments/${comment.id}`,
        html_url: `https://example.invalid/${login}/${repoName}/issues/${issue.number}#issuecomment-${comment.id}`,
      }));
      return withLink(jsonResponse(200, out), link);
    }
    return notFound('Not Found');
  }

  return notFound('Not Found');
}

// -------------------------------------------------------------------------------------------
// pull requests
// -------------------------------------------------------------------------------------------

function handlePulls(
  forge: Forge,
  req: HttpRequest,
  owner: string,
  repoName: string,
  repo: Repo,
  rest: string[],
): HttpResponse {
  const login = ownerLogin(forge, owner);
  const method = req.method;

  // /pulls — create or list
  if (rest.length === 0) {
    if (method === 'POST') {
      const parsed = readJsonBody(req);
      if (!parsed.ok) return parsed.response;
      const body = parsed.value;
      const title = asString(body.title);
      const head = asString(body.head);
      const base = asString(body.base);
      if (!title || !head || !base) return unprocessable('title, head and base are required');
      const headRef = head.startsWith('refs/') ? head : `refs/heads/${head}`;
      const baseRef = base.startsWith('refs/') ? base : `refs/heads/${base}`;
      const headSha = forge.getRef(repo, headRef);
      const baseSha = forge.getRef(repo, baseRef);
      if (!headSha || !baseSha) return unprocessable('head or base branch does not exist');
      const pull: Pull = {
        number: repo.pullSeq++,
        title,
        body: asString(body.body) ?? '',
        state: 'open',
        headRef: headRef.slice('refs/heads/'.length),
        baseRef: baseRef.slice('refs/heads/'.length),
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: forge.nextSeq(),
      };
      repo.pulls.push(pull);
      return jsonResponse(201, pullJson(forge, owner, repo, pull));
    }
    if (method === 'GET') {
      const state = req.search.get('state') ?? 'open';
      const pulls = repo.pulls
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => b.createdAt - a.createdAt);
      const { page, link } = paginate(pulls, req);
      return withLink(jsonResponse(200, page.map((pull) => pullJson(forge, owner, repo, pull))), link);
    }
    return notFound('Not Found');
  }

  const number = Number.parseInt(rest[0] ?? '', 10);
  if (!Number.isFinite(number)) return notFound('Not Found');
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (!pull) return notFound('Not Found');

  // /pulls/{n}
  if (rest.length === 1) {
    if (method === 'GET') return jsonResponse(200, pullJson(forge, owner, repo, pull));
    return notFound('Not Found');
  }

  // /pulls/{n}/files
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const baseCommit = forge.getObject(repo, pull.baseSha);
    const headCommit = forge.getObject(repo, pull.headSha);
    if (!baseCommit || !headCommit) return notFound('Not Found');
    const baseFiles = forge.flattenTree(repo, parseCommit(baseCommit.data).tree);
    const headFiles = forge.flattenTree(repo, parseCommit(headCommit.data).tree);
    const files: Array<Record<string, unknown>> = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const baseVal = baseFiles.get(path);
      const headVal = headFiles.get(path);
      if (baseVal?.oid === headVal?.oid) continue;
      let status: string;
      let additions = 0;
      let deletions = 0;
      if (!baseVal && headVal) {
        status = 'added';
        const blob = forge.getObject(repo, headVal.oid);
        const text = blob ? blob.data.toString('utf8') : '';
        additions = text.length === 0 ? 0 : text.split('\n').length;
        deletions = 0;
      } else if (baseVal && !headVal) {
        status = 'removed';
        const blob = forge.getObject(repo, baseVal.oid);
        const text = blob ? blob.data.toString('utf8') : '';
        deletions = text.length === 0 ? 0 : text.split('\n').length;
        additions = 0;
      } else {
        status = 'modified';
        const before = forge.getObject(repo, baseVal!.oid)?.data.toString('utf8') ?? '';
        const after = forge.getObject(repo, headVal!.oid)?.data.toString('utf8') ?? '';
        const diff = diffLines(before, after);
        additions = diff.additions;
        deletions = diff.deletions;
      }
      files.push({
        filename: path,
        status,
        additions,
        deletions,
        changes: additions + deletions,
        sha: headVal?.oid ?? baseVal?.oid ?? '',
      });
    }
    const { page, link } = paginate(files, req);
    return withLink(jsonResponse(200, page), link);
  }

  // /pulls/{n}/merge
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const parsed = readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const mergeMethod = asString(parsed.value.merge_method) ?? 'merge';
    if (pull.merged || pull.state === 'closed') {
      return jsonResponse(405, { message: 'Pull request has already been merged or closed' });
    }
    const baseRef = `refs/heads/${pull.baseRef}`;
    // Merge against the base branch as it stands now, not the tip recorded
    // when the pull request was opened: another pull request may have merged
    // first and advanced it, and that is exactly when a conflict appears.
    const currentBase = forge.getRef(repo, baseRef);
    if (!currentBase) {
      return jsonResponse(409, { message: 'base branch does not exist' });
    }
    const merged = forge.threeWayMerge(repo, currentBase, pull.headSha);
    if (merged.conflicts.length > 0) {
      return jsonResponse(405, { message: `Merge conflict in ${merged.conflicts.join(', ')}` });
    }
    // A squash merge is one commit on the base branch with the merged tree;
    // a merge commit has both tips as parents. Rebase is treated as squash.
    const message =
      mergeMethod === 'squash' ? pull.title : `Merge pull request #${pull.number} from ${pull.headRef}`;
    const parents = mergeMethod === 'merge' ? [currentBase, pull.headSha] : [currentBase];
    const mergeCommit = forge.putObject(
      repo,
      'commit',
      buildCommit({ tree: merged.treeOid, parents, message }),
    );
    forge.setRef(repo, baseRef, mergeCommit);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = isoNow();
    pull.mergeCommitSha = mergeCommit;
    return jsonResponse(200, { sha: mergeCommit, merged: true, message });
  }

  return notFound('Not Found');
}
