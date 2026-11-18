// rest.ts — the REST v3 surface under `/api/v3`: repositories, branches,
// commits, the contents API, labels, issues, comments and pull requests.
// Every response is JSON (never HTML) and carries X-GitHub-Request-Id;
// a route nothing matches is a JSON 404.
//
// Performance notes: issue and pull lookups by number index straight into
// the array (numbers run sequentially from 1 and are never removed — see
// store.ts), each serialized body stamps its timestamps once per object
// rather than once per field, and pagination links are built from the raw
// query string with no URLSearchParams round-trip.

import { buildCommit, isObjectId, parseCommit, parseTree, ZERO_OID } from './git.ts';
import { findIssue, findPull, type Forge, type Issue, type Label, type Pull, type Repo } from './store.ts';
import {
  badRequest,
  binaryResponse,
  jsonResponse,
  notFound,
  unprocessable,
  type HttpRequest,
  type HttpResponse,
} from './httputil.ts';

/** The current timestamp in ISO form. */
function nowIso(): string {
  return new Date().toISOString();
}

/** The login the token acts as, falling back to the path owner. */
function actingLogin(store: Forge, owner: string): string {
  return store.viewerLogin ?? owner;
}

/** The small user object every serialized body embeds. */
function actorJson(login: string): Record<string, unknown> {
  return { login, id: 1000, type: 'User' };
}

/** Serialize a repository into the v3 repository shape. */
function serializeRepo(store: Forge, owner: string, repository: Repo): Record<string, unknown> {
  const login = actingLogin(store, owner);
  const stamped = nowIso();
  return {
    id: repository.id,
    name: repository.name,
    full_name: `${login}/${repository.name}`,
    owner: actorJson(login),
    private: repository.private,
    description: repository.description,
    default_branch: repository.defaultBranch,
    html_url: `https://example.invalid/${login}/${repository.name}`,
    url: `/api/v3/repos/${login}/${repository.name}`,
    git_url: `git://example.invalid/${login}/${repository.name}.git`,
    ssh_url: `git@example.invalid:${login}/${repository.name}.git`,
    clone_url: `https://example.invalid/${login}/${repository.name}.git`,
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    open_issues_count: repository.issues.filter((ticket) => ticket.state === 'open').length,
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
    created_at: stamped,
    updated_at: stamped,
    pushed_at: stamped,
  };
}

/** Serialize an issue into the v3 issue shape. */
function serializeIssue(store: Forge, owner: string, repository: Repo, ticket: Issue): Record<string, unknown> {
  const login = actingLogin(store, owner);
  const stamped = nowIso();
  return {
    id: repository.id * 100000 + ticket.number,
    number: ticket.number,
    title: ticket.title,
    body: ticket.body,
    state: ticket.state,
    labels: ticket.labels.map((label) => ({ id: 1, name: label.name, color: label.color, url: `/api/v3/repos/${login}/${repository.name}/labels/${encodeURIComponent(label.name)}`, description: '' })),
    user: actorJson(login),
    created_at: stamped,
    updated_at: stamped,
    closed_at: ticket.state === 'closed' ? stamped : null,
    url: `/api/v3/repos/${login}/${repository.name}/issues/${ticket.number}`,
    html_url: `https://example.invalid/${login}/${repository.name}/issues/${ticket.number}`,
    comments: ticket.comments.length,
    comments_url: `/api/v3/repos/${login}/${repository.name}/issues/${ticket.number}/comments`,
  };
}

/** Serialize a pull request into the v3 pull shape. */
function serializePull(store: Forge, owner: string, repository: Repo, pr: Pull): Record<string, unknown> {
  const login = actingLogin(store, owner);
  const stamped = nowIso();
  return {
    id: repository.id * 100000 + pr.number,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${login}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${login}:${pr.baseRef}` },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    user: actorJson(login),
    created_at: stamped,
    updated_at: stamped,
    closed_at: pr.state === 'closed' ? stamped : null,
    url: `/api/v3/repos/${login}/${repository.name}/pulls/${pr.number}`,
    html_url: `https://example.invalid/${login}/${repository.name}/pull/${pr.number}`,
  };
}

/**
 * Parse a JSON request body. An empty body yields an empty object; a body
 * that is not a JSON object yields an error response to return.
 */
function parseBody(req: HttpRequest): { ok: true; value: Record<string, unknown> } | { ok: false; response: HttpResponse } {
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

/** The body field as a string, or undefined when it is absent or not a string. */
function strField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The body field as a boolean, or undefined when it is absent or not a boolean. */
function boolField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** The body field as a finite number, or undefined otherwise. */
function numField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Slice `items` to the requested `page`/`per_page` and, when a further page
 * exists, build its Link header value ('' when there is no next page).
 */
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
  if (start + perPage < items.length) {
    const host = req.headers.get('host') ?? '127.0.0.1';
    const query = req.search.with({ per_page: String(perPage), page: String(page + 1) });
    link = `<http://${host}${req.pathname}?${query}>; rel="next"`;
  }
  return { page: slice, link };
}

/** Attach a Link header to a response when one was built; a no-op otherwise. */
function attachLink(response: HttpResponse, link: string): HttpResponse {
  if (!link) return response;
  return { ...response, headers: { ...response.headers, Link: link } };
}

/** Look a repository up by owner and name: null when it is not there. */
function lookupRepo(store: Forge, owner: string, name: string): Repo | null {
  return store.getRepo(owner, name) ?? null;
}

/** Count added and removed lines between two texts (multiset difference). */
function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const tally = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const line of text.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const beforeCounts = tally(before);
  const afterCounts = tally(after);
  let additions = 0;
  for (const [line, n] of afterCounts) additions += Math.max(0, n - (beforeCounts.get(line) ?? 0));
  let deletions = 0;
  for (const [line, n] of beforeCounts) deletions += Math.max(0, n - (afterCounts.get(line) ?? 0));
  return { additions, deletions };
}

// -------------------------------------------------------------------------------------------
// top-level routing
// -------------------------------------------------------------------------------------------

export function handleRest(store: Forge, req: HttpRequest): HttpResponse | null {
  const path = req.pathname;
  if (!path.startsWith('/api/v3')) return null;
  const restPath = path.slice('/api/v3'.length);
  const segments = restPath.split('/').filter((segment) => segment.length > 0);
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
    const login = store.viewerLogin ?? '';
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

  // /user/repos — create a repository, or list the viewer's repositories.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.response;
      const body = parsed.value;
      const name = strField(body.name);
      if (!name) return unprocessable('name is required');
      if (store.getRepoByName(name)) return unprocessable('name already exists on this account');
      const repository = store.createRepo(name, strField(body.description) ?? '', boolField(body.private) ?? false);
      return jsonResponse(201, serializeRepo(store, store.viewerLogin ?? '', repository));
    }
    if (method === 'GET') {
      const repos = store.listRepos();
      const { page, link } = paginate(repos, req);
      return attachLink(jsonResponse(200, page.map((repository) => serializeRepo(store, store.viewerLogin ?? '', repository))), link);
    }
    return null;
  }

  // /repos/{owner}/{repo}... — everything scoped to one repository.
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1]!;
    const repoName = segments[2]!;
    const repository = lookupRepo(store, owner, repoName);
    if (!repository) return notFound('Not Found');
    const login = actingLogin(store, owner);
    const tail = segments.slice(3);

    // GET / PATCH / DELETE /repos/{owner}/{repo}
    if (tail.length === 0) {
      if (method === 'GET') return jsonResponse(200, serializeRepo(store, owner, repository));
      if (method === 'PATCH') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.response;
        const description = strField(parsed.value.description);
        if (description !== undefined) repository.description = description;
        const isPrivate = boolField(parsed.value.private);
        if (isPrivate !== undefined) repository.private = isPrivate;
        return jsonResponse(200, serializeRepo(store, owner, repository));
      }
      if (method === 'DELETE') {
        store.deleteRepo(repoName);
        return { status: 204, headers: { 'X-GitHub-Request-Id': jsonResponse(204, {}).headers['X-GitHub-Request-Id']! }, body: Buffer.alloc(0) };
      }
      return null;
    }

    // GET /repos/{owner}/{repo}/branches
    if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
      const branches = store.listRefs(repository)
        .filter((ref) => ref.name.startsWith('refs/heads/'))
        .map((ref) => ({
          name: ref.name.slice('refs/heads/'.length),
          commit: { sha: ref.oid, url: `/api/v3/repos/${login}/${repoName}/commits/${ref.oid}` },
          protected: false,
        }));
      return jsonResponse(200, branches);
    }

    // GET /repos/{owner}/{repo}/commits
    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const shaParam = req.search.get('sha');
      let tip: string | undefined;
      if (shaParam) {
        if (shaParam.startsWith('refs/')) tip = store.getRef(repository, shaParam);
        else if (store.getRef(repository, `refs/heads/${shaParam}`)) tip = store.getRef(repository, `refs/heads/${shaParam}`);
        else if (store.getRef(repository, `refs/tags/${shaParam}`)) tip = store.getRef(repository, `refs/tags/${shaParam}`);
        else if (isObjectId(shaParam)) tip = shaParam;
        else tip = undefined;
      } else {
        tip = store.headOid(repository);
      }
      if (!tip || tip === ZERO_OID) return jsonResponse(200, []);
      const history = store.commitHistory(repository, tip);
      const entries = history.map((oid) => {
        const object = store.getObject(repository, oid)!;
        const commit = parseCommit(object.data);
        return {
          sha: oid,
          commit: { message: commit.message, author: { name: 'Conformance', email: 'conformance@make.fun', date: nowIso() }, committer: { name: 'Conformance', email: 'conformance@make.fun', date: nowIso() } },
          author: actorJson(login),
          url: `/api/v3/repos/${login}/${repoName}/commits/${oid}`,
        };
      });
      const { page, link } = paginate(entries, req);
      return attachLink(jsonResponse(200, page), link);
    }

    // POST /repos/{owner}/{repo}/git/refs — create a branch.
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.response;
      const ref = strField(parsed.value.ref);
      const sha = strField(parsed.value.sha);
      if (!ref || !sha || !isObjectId(sha)) return unprocessable('ref and sha are required');
      if (!ref.startsWith('refs/')) return unprocessable('ref must start with refs/');
      if (store.getRef(repository, ref)) return unprocessable('Reference already exists');
      if (!store.getObject(repository, sha)) return unprocessable('Object does not exist');
      store.setRef(repository, ref, sha);
      return jsonResponse(201, { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${login}/${repoName}/git/commits/${sha}` }, url: `/api/v3/repos/${login}/${repoName}/git/refs/${ref}` });
    }

    // GET /repos/{owner}/{repo}/git/refs — list every ref.
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'GET') {
      const refs = store.listRefs(repository).map((ref) => ({
        ref: ref.name,
        object: { sha: ref.oid, type: 'commit', url: `/api/v3/repos/${login}/${repoName}/git/commits/${ref.oid}` },
        url: `/api/v3/repos/${login}/${repoName}/git/refs/${ref.name}`,
      }));
      return jsonResponse(200, refs);
    }

    // GET /repos/{owner}/{repo}/git/refs/{ref...} — one ref.
    if (tail.length >= 3 && tail[0] === 'git' && tail[1] === 'refs' && method === 'GET') {
      const refName = `refs/${tail.slice(2).join('/')}`;
      const oid = store.getRef(repository, refName);
      if (!oid) return notFound('Not Found');
      return jsonResponse(200, {
        ref: refName,
        object: { sha: oid, type: 'commit', url: `/api/v3/repos/${login}/${repoName}/git/commits/${oid}` },
        url: `/api/v3/repos/${login}/${repoName}/git/refs/${refName}`,
      });
    }

    // GET /repos/{owner}/{repo}/branches/{branch} — one branch.
    if (tail.length === 2 && tail[0] === 'branches' && method === 'GET') {
      const branch = tail[1]!;
      const oid = store.getRef(repository, `refs/heads/${branch}`);
      if (!oid) return notFound('Not Found');
      return jsonResponse(200, {
        name: branch,
        commit: { sha: oid, url: `/api/v3/repos/${login}/${repoName}/commits/${oid}` },
        protected: false,
      });
    }

    // /repos/{owner}/{repo}/contents/{path...}
    if (tail.length >= 2 && tail[0] === 'contents') {
      return handleContents(store, req, owner, repoName, repository, tail.slice(1).join('/'));
    }

    // /repos/{owner}/{repo}/labels
    if (tail.length === 1 && tail[0] === 'labels') {
      if (method === 'POST') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.response;
        const name = strField(parsed.value.name);
        const color = strField(parsed.value.color);
        if (!name || !color) return unprocessable('name and color are required');
        if (repository.labels.has(name)) return unprocessable('Label already exists');
        const label: Label = { name, color };
        repository.labels.set(name, label);
        return jsonResponse(201, { id: repository.labels.size, name, color, url: `/api/v3/repos/${login}/${repoName}/labels/${encodeURIComponent(name)}`, description: '' });
      }
      if (method === 'GET') {
        const labels = [...repository.labels.values()].map((label) => ({
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
    if (tail[0] === 'issues') {
      return handleIssues(store, req, owner, repoName, repository, tail.slice(1));
    }

    // /repos/{owner}/{repo}/pulls...
    if (tail[0] === 'pulls') {
      return handlePulls(store, req, owner, repoName, repository, tail.slice(1));
    }

    return notFound('Not Found');
  }

  return null;
}

// -------------------------------------------------------------------------------------------
// contents API
// -------------------------------------------------------------------------------------------

/** Turn a ?ref= or body.branch value into a commit id. */
function resolveContentRef(store: Forge, repository: Repo, ref: string | undefined): string | undefined {
  if (!ref) return store.headOid(repository);
  if (store.getRef(repository, ref)) return store.getRef(repository, ref);
  if (store.getRef(repository, `refs/heads/${ref}`)) return store.getRef(repository, `refs/heads/${ref}`);
  if (store.getRef(repository, `refs/tags/${ref}`)) return store.getRef(repository, `refs/tags/${ref}`);
  if (isObjectId(ref) && store.getObject(repository, ref)) return ref;
  return undefined;
}

function handleContents(
  store: Forge,
  req: HttpRequest,
  owner: string,
  repoName: string,
  repository: Repo,
  path: string,
): HttpResponse {
  const login = actingLogin(store, owner);
  const method = req.method;
  const decodedPath = decodeURIComponent(path);

  if (method === 'GET') {
    const tip = resolveContentRef(store, repository, req.search.get('ref') ?? undefined);
    if (!tip || tip === ZERO_OID) return notFound('Not Found');
    const file = store.readFileAt(repository, tip, decodedPath);
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
        html_url: `https://example.invalid/${login}/${repoName}/blob/${repository.defaultBranch}/${path}`,
        download_url: `https://example.invalid/${login}/${repoName}/raw/${repository.defaultBranch}/${path}`,
      });
    }
    const entries = store.listDirAt(repository, tip, decodedPath);
    if (entries) {
      return jsonResponse(
        200,
        entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: decodedPath ? `${decodedPath}/${entry.name}` : entry.name,
          sha: entry.oid,
          size: entry.mode === '40000' ? 0 : (store.getObject(repository, entry.oid)?.data.length ?? 0),
          url: `/api/v3/repos/${login}/${repoName}/contents/${decodedPath ? `${decodedPath}/` : ''}${entry.name}`,
          html_url: `https://example.invalid/${login}/${repoName}/tree/${repository.defaultBranch}/${decodedPath ? `${decodedPath}/` : ''}${entry.name}`,
          download_url: entry.mode === '40000' ? null : `https://example.invalid/${login}/${repoName}/raw/${repository.defaultBranch}/${decodedPath ? `${decodedPath}/` : ''}${entry.name}`,
        })),
      );
    }
    return notFound('Not Found');
  }

  if (method === 'PUT') {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const message = strField(body.message) ?? `Update ${decodedPath}`;
    const contentB64 = strField(body.content);
    if (contentB64 === undefined) return unprocessable('content is required');
    let data: Buffer;
    try {
      data = Buffer.from(contentB64, 'base64');
    } catch {
      return badRequest('content is not valid base64');
    }
    const branchName = strField(body.branch) ?? req.search.get('ref') ?? repository.defaultBranch;
    const branchRef = branchName.startsWith('refs/') ? branchName : `refs/heads/${branchName}`;
    const tip = store.getRef(repository, branchRef);
    const existing = tip ? store.readFileAt(repository, tip, decodedPath) : null;
    const givenSha = strField(body.sha);
    if (givenSha && existing && givenSha !== existing.oid) {
      return jsonResponse(409, { message: 'sha does not match the current file' });
    }
    const isUpdate = existing !== null;
    const commitOid = store.commitFile(repository, branchRef, decodedPath, data, message);
    const blobOid = store.readFileAt(repository, commitOid, decodedPath)!.oid;
    return jsonResponse(isUpdate ? 200 : 201, {
      content: {
        name: decodedPath.split('/').pop() ?? decodedPath,
        path: decodedPath,
        sha: blobOid,
        size: data.length,
        url: `/api/v3/repos/${login}/${repoName}/contents/${path}`,
        html_url: `https://example.invalid/${login}/${repoName}/blob/${repository.defaultBranch}/${path}`,
        download_url: `https://example.invalid/${login}/${repoName}/raw/${repository.defaultBranch}/${path}`,
        type: 'file',
        encoding: 'base64',
      },
      commit: {
        sha: commitOid,
        message,
        author: { name: 'Conformance', email: 'conformance@make.fun', date: nowIso() },
        committer: { name: 'Conformance', email: 'conformance@make.fun', date: nowIso() },
      },
    });
  }

  if (method === 'DELETE') {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const message = strField(body.message) ?? `Delete ${decodedPath}`;
    const branchName = strField(body.branch) ?? req.search.get('ref') ?? repository.defaultBranch;
    const branchRef = branchName.startsWith('refs/') ? branchName : `refs/heads/${branchName}`;
    const tip = store.getRef(repository, branchRef);
    const existing = tip ? store.readFileAt(repository, tip, decodedPath) : null;
    if (!existing) return notFound('Not Found');
    const givenSha = strField(body.sha);
    if (givenSha && givenSha !== existing.oid) {
      return jsonResponse(409, { message: 'sha does not match the current file' });
    }
    const commitOid = store.commitDeleteFile(repository, branchRef, decodedPath, message);
    return jsonResponse(200, {
      commit: {
        sha: commitOid,
        message,
        author: { name: 'Conformance', email: 'conformance@make.fun', date: nowIso() },
        committer: { name: 'Conformance', email: 'conformance@make.fun', date: nowIso() },
      },
    });
  }

  return notFound('Not Found');
}

// -------------------------------------------------------------------------------------------
// issues
// -------------------------------------------------------------------------------------------

function handleIssues(
  store: Forge,
  req: HttpRequest,
  owner: string,
  repoName: string,
  repository: Repo,
  tail: string[],
): HttpResponse {
  const login = actingLogin(store, owner);
  const method = req.method;

  // /issues — create one, or list them.
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.response;
      const body = parsed.value;
      const title = strField(body.title);
      if (!title) return unprocessable('title is required');
      const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      const labels: Label[] = [];
      for (const name of labelNames) {
        const label = repository.labels.get(name);
        if (!label) return unprocessable(`Label ${JSON.stringify(name)} does not exist`);
        labels.push(label);
      }
      const ticket: Issue = {
        number: repository.issueSeq++,
        title,
        body: strField(body.body) ?? '',
        state: 'open',
        labels,
        createdAt: store.nextSeq(),
        comments: [],
      };
      repository.issues.push(ticket);
      return jsonResponse(201, serializeIssue(store, owner, repository, ticket));
    }
    if (method === 'GET') {
      const state = req.search.get('state') ?? 'open';
      const sort = req.search.get('sort') ?? 'created';
      const direction = req.search.get('direction') ?? 'desc';
      let tickets = repository.issues.filter((ticket) => state === 'all' || ticket.state === state);
      if (sort === 'created') {
        tickets = [...tickets].sort((a, b) => (direction === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
      }
      const { page, link } = paginate(tickets, req);
      const out = page.map((ticket) => serializeIssue(store, owner, repository, ticket));
      return attachLink(jsonResponse(200, out), link);
    }
    return notFound('Not Found');
  }

  const number = Number.parseInt(tail[0] ?? '', 10);
  if (!Number.isFinite(number)) return notFound('Not Found');
  const ticket = findIssue(repository, number);
  if (!ticket) return notFound('Not Found');

  // /issues/{n}
  if (tail.length === 1) {
    if (method === 'GET') return jsonResponse(200, serializeIssue(store, owner, repository, ticket));
    if (method === 'PATCH') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.response;
      const body = parsed.value;
      const state = strField(body.state);
      if (state === 'open' || state === 'closed') ticket.state = state;
      const title = strField(body.title);
      if (title !== undefined) ticket.title = title;
      const text = strField(body.body);
      if (text !== undefined) ticket.body = text;
      return jsonResponse(200, serializeIssue(store, owner, repository, ticket));
    }
    return notFound('Not Found');
  }

  // /issues/{n}/comments
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.response;
      const text = strField(parsed.value.body);
      if (!text) return unprocessable('body is required');
      const comment = { id: repository.commentSeq++, body: text, createdAt: store.nextSeq() };
      ticket.comments.push(comment);
      return jsonResponse(201, {
        id: comment.id,
        body: comment.body,
        user: actorJson(login),
        created_at: nowIso(),
        updated_at: nowIso(),
        url: `/api/v3/repos/${login}/${repoName}/issues/comments/${comment.id}`,
        html_url: `https://example.invalid/${login}/${repoName}/issues/${ticket.number}#issuecomment-${comment.id}`,
      });
    }
    if (method === 'GET') {
      const { page, link } = paginate(ticket.comments, req);
      const out = page.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: actorJson(login),
        created_at: nowIso(),
        updated_at: nowIso(),
        url: `/api/v3/repos/${login}/${repoName}/issues/comments/${comment.id}`,
        html_url: `https://example.invalid/${login}/${repoName}/issues/${ticket.number}#issuecomment-${comment.id}`,
      }));
      return attachLink(jsonResponse(200, out), link);
    }
    return notFound('Not Found');
  }

  return notFound('Not Found');
}

// -------------------------------------------------------------------------------------------
// pull requests
// -------------------------------------------------------------------------------------------

function handlePulls(
  store: Forge,
  req: HttpRequest,
  owner: string,
  repoName: string,
  repository: Repo,
  tail: string[],
): HttpResponse {
  const login = actingLogin(store, owner);
  const method = req.method;

  // /pulls — open one, or list them.
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.response;
      const body = parsed.value;
      const title = strField(body.title);
      const head = strField(body.head);
      const base = strField(body.base);
      if (!title || !head || !base) return unprocessable('title, head and base are required');
      const headRef = head.startsWith('refs/') ? head : `refs/heads/${head}`;
      const baseRef = base.startsWith('refs/') ? base : `refs/heads/${base}`;
      const headSha = store.getRef(repository, headRef);
      const baseSha = store.getRef(repository, baseRef);
      if (!headSha || !baseSha) return unprocessable('head or base branch does not exist');
      const pr: Pull = {
        number: repository.pullSeq++,
        title,
        body: strField(body.body) ?? '',
        state: 'open',
        headRef: headRef.slice('refs/heads/'.length),
        baseRef: baseRef.slice('refs/heads/'.length),
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: store.nextSeq(),
      };
      repository.pulls.push(pr);
      return jsonResponse(201, serializePull(store, owner, repository, pr));
    }
    if (method === 'GET') {
      const state = req.search.get('state') ?? 'open';
      const prs = repository.pulls
        .filter((pr) => state === 'all' || pr.state === state)
        .sort((a, b) => b.createdAt - a.createdAt);
      const { page, link } = paginate(prs, req);
      return attachLink(jsonResponse(200, page.map((pr) => serializePull(store, owner, repository, pr))), link);
    }
    return notFound('Not Found');
  }

  const number = Number.parseInt(tail[0] ?? '', 10);
  if (!Number.isFinite(number)) return notFound('Not Found');
  const pr = findPull(repository, number);
  if (!pr) return notFound('Not Found');

  // /pulls/{n}
  if (tail.length === 1) {
    if (method === 'GET') return jsonResponse(200, serializePull(store, owner, repository, pr));
    return notFound('Not Found');
  }

  // /pulls/{n}/files
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const baseCommit = store.getObject(repository, pr.baseSha);
    const headCommit = store.getObject(repository, pr.headSha);
    if (!baseCommit || !headCommit) return notFound('Not Found');
    const baseFiles = store.flattenTree(repository, parseCommit(baseCommit.data).tree);
    const headFiles = store.flattenTree(repository, parseCommit(headCommit.data).tree);
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
        const blob = store.getObject(repository, headVal.oid);
        const text = blob ? blob.data.toString('utf8') : '';
        additions = text.length === 0 ? 0 : text.split('\n').length;
        deletions = 0;
      } else if (baseVal && !headVal) {
        status = 'removed';
        const blob = store.getObject(repository, baseVal.oid);
        const text = blob ? blob.data.toString('utf8') : '';
        deletions = text.length === 0 ? 0 : text.split('\n').length;
        additions = 0;
      } else {
        status = 'modified';
        const before = store.getObject(repository, baseVal!.oid)?.data.toString('utf8') ?? '';
        const after = store.getObject(repository, headVal!.oid)?.data.toString('utf8') ?? '';
        const diff = lineDiff(before, after);
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
    return attachLink(jsonResponse(200, page), link);
  }

  // /pulls/{n}/merge
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.response;
    const mergeMethod = strField(parsed.value.merge_method) ?? 'merge';
    if (pr.merged || pr.state === 'closed') {
      return jsonResponse(405, { message: 'Pull request has already been merged or closed' });
    }
    const baseRef = `refs/heads/${pr.baseRef}`;
    // Merge against the base branch as it stands now, not the tip recorded
    // when the pull request was opened: another pull request may have merged
    // first and advanced it, and that is exactly when a conflict appears.
    const currentBase = store.getRef(repository, baseRef);
    if (!currentBase) {
      return jsonResponse(409, { message: 'base branch does not exist' });
    }
    const merged = store.threeWayMerge(repository, currentBase, pr.headSha);
    if (merged.conflicts.length > 0) {
      return jsonResponse(405, { message: `Merge conflict in ${merged.conflicts.join(', ')}` });
    }
    // A squash merge is one commit on the base branch with the merged tree;
    // a merge commit has both tips as parents. Rebase is treated as squash.
    const message =
      mergeMethod === 'squash' ? pr.title : `Merge pull request #${pr.number} from ${pr.headRef}`;
    const parents = mergeMethod === 'merge' ? [currentBase, pr.headSha] : [currentBase];
    const mergeCommit = store.putObject(
      repository,
      'commit',
      buildCommit({ tree: merged.treeOid, parents, message }),
    );
    store.setRef(repository, baseRef, mergeCommit);
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = nowIso();
    pr.mergeCommitSha = mergeCommit;
    return jsonResponse(200, { sha: mergeCommit, merged: true, message });
  }

  return notFound('Not Found');
}
