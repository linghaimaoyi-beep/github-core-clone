// app.ts — the HTTP server: takes each complete request, checks the bearer
// token, routes to the git / REST / GraphQL / MCP handlers, and returns the
// reply. Only GET /healthz is unauthenticated (the env's boot probe).
//
// The transport is the hand-rolled HTTP/1.1 server in rawserver.ts, not
// node:http: the kit's runner makes thousands of small sequential requests,
// and node:http's per-request machinery (IncomingMessage/ServerResponse,
// the readBody promise, writeHead/end bookkeeping) is a fixed tax on each
// one. The raw server hands the whole request to this file synchronously,
// so there is no stream to drain and no promise to await per request.
//
// Auth model: the shop token comes from MAKEFUN_SHOP_TOKEN. When the
// environment sets one, the presented bearer token must match it exactly.
// When it sets none (local practice runs), any non-empty bearer token is
// accepted — but a request with no bearer token at all is still refused.
// The viewer login is learned from the first owner named in a path (see
// store.ts `isViewer`), which is why the git checks must run before any
// route names a foreign owner.
//
// Hot-path notes: the URL is split by hand (no `new URL()`), headers are
// read straight off the parsed object (no Map copy), bodies arrive whole
// from the raw server, and routing short-circuits on cheap prefix checks
// before any regex runs.

import { type Server } from 'node:net';
import { createRawServer, type RawRequest } from './rawserver.ts';
import { Forge } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  FastSearchParams,
  IncomingHeadersMap,
  binaryResponse,
  jsonResponse,
  nextRequestId,
  notFound,
  unauthorized,
  type HttpRequest,
  type HttpResponse,
} from './httputil.ts';

/** Build the forge from the environment's shop token (null when unset). */
export function createForge(): Forge {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? null;
  return new Forge(token && token.length > 0 ? token : null);
}

const HEALTHZ_BODY = Buffer.from('{"ok":true,"status":"ok"}', 'utf8');
const REF_HEAD_BODY = Buffer.from('ref: refs/heads/main\n', 'utf8');

/**
 * The bearer token a request presents, or null when it presents none.
 * Plain prefix matching — no regex, no trim allocation on the common path.
 */
function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  // "Bearer <token>" with a single space is what every client sends.
  if (header.charCodeAt(0) === 66 && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    return token.length > 0 ? token : null;
  }
  // Anything else: trim once and try the usual spellings.
  const trimmed = header.trim();
  if (trimmed.startsWith('Bearer ') || trimmed.startsWith('Bearer\t')) {
    const token = trimmed.slice(7).trim();
    return token.length > 0 ? token : null;
  }
  return null;
}

/** Route one request to a handler and return its response. */
function dispatch(store: Forge, req: HttpRequest): HttpResponse {
  const path = req.pathname;

  // The boot probe: no auth, always 200.
  if (path === '/healthz' && req.method === 'GET') {
    return {
      status: 200,
      headers: { 'content-type': 'application/json', 'X-GitHub-Request-Id': nextRequestId() },
      body: HEALTHZ_BODY,
    };
  }

  // GraphQL lives at /api/graphql (not /graphql). Only POST is a call;
  // anything else on the path is a 405 from the handler itself.
  if (path === '/api/graphql') {
    const graphql = handleGraphQL(store, req);
    if (graphql !== null) return graphql;
    return notFound('Not Found');
  }

  // MCP lives at /mcp.
  if (path === '/mcp') {
    const mcp = handleMcp(store, req);
    if (mcp !== null) return mcp;
    return notFound('Not Found');
  }

  // Git smart HTTP: /{owner}/{repo}.git/... — skip the regex entirely when
  // the path has no ".git" in it (every REST/GraphQL/MCP request).
  if (path.indexOf('.git') !== -1) {
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]!);
      const repoName = decodeURIComponent(gitMatch[2]!);
      const suffix = gitMatch[3] ?? '';
      const gitProtocol = req.headers.get('git-protocol');
      if (suffix === '/info/refs' && req.method === 'GET') {
        const service = req.search.get('service');
        if (service === 'git-upload-pack' || service === 'git-receive-pack') {
          return handleInfoRefs(store, owner, repoName, service, gitProtocol);
        }
        return notFound('Not Found');
      }
      if (suffix === '/git-upload-pack' && req.method === 'POST') {
        return handleUploadPack(store, owner, repoName, req.body);
      }
      if (suffix === '/git-receive-pack' && req.method === 'POST') {
        return handleReceivePack(store, owner, repoName, req.body);
      }
      if (suffix === '/HEAD' && req.method === 'GET') {
        return binaryResponse(200, REF_HEAD_BODY, 'text/plain');
      }
      return notFound('Not Found');
    }
  }

  // REST v3 (returns null for anything outside /api/v3).
  const rest = handleRest(store, req);
  if (rest !== null) return rest;

  return notFound('Not Found');
}

/**
 * Handle one complete request: split the URL by hand, build the request
 * the handlers expect, check the bearer token, and dispatch. Synchronous:
 * the raw server already holds the whole body, so there is no stream to
 * drain and no promise to await. The auth and routing logic is the same
 * as the old node:http callback — only the transport around it changed.
 */
function handleHttpRequest(store: Forge, raw: RawRequest): HttpResponse {
  // Split path and query by hand: the request target is always
  // origin-form ("/path?query"), never a full URL.
  const rawUrl = raw.url;
  const qIdx = rawUrl.indexOf('?');
  const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  const rawQuery = qIdx === -1 ? '' : rawUrl.slice(qIdx + 1);
  const request: HttpRequest = {
    method: raw.method,
    pathname,
    search: new FastSearchParams(rawQuery),
    headers: new IncomingHeadersMap(raw.headers),
    body: raw.body,
  };
  // Authentication: every route except /healthz needs the shop token.
  // When the environment sets no token (local practice), any non-empty
  // bearer token is accepted; a missing one is still refused.
  if (pathname !== '/healthz') {
    const auth = raw.headers.authorization;
    const presented = extractBearer(typeof auth === 'string' ? auth : undefined);
    if (presented === null) return unauthorized('Requires authentication');
    if (store.token !== null && presented !== store.token) return unauthorized('Bad credentials');
  }
  return dispatch(store, request);
}

/** Create the HTTP server for one forge. */
export function createApp(store: Forge = createForge()): Server {
  return createRawServer((raw: RawRequest) => {
    try {
      return handleHttpRequest(store, raw);
    } catch (err) {
      // Never let one request take the server down: answer 500 and stay up.
      process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return {
        status: 500,
        headers: { 'content-type': 'application/json', 'X-GitHub-Request-Id': nextRequestId() },
        body: Buffer.from(JSON.stringify({ message: 'Internal Server Error' }), 'utf8'),
      };
    }
  });
}
