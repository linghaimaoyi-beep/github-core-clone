// app.ts — the HTTP server: reads each request whole, checks the bearer
// token, routes to the git / REST / GraphQL / MCP handlers, and writes the
// reply. Only GET /healthz is unauthenticated (the env's boot probe).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  binaryResponse,
  jsonResponse,
  notFound,
  unauthorized,
  type HttpRequest,
} from './httputil.ts';

/** Build the forge from the environment's shop token (null when unset). */
export function createForge(): Forge {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? null;
  return new Forge(token && token.length > 0 ? token : null);
}

/** Read a request body fully into a Buffer. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer token a request presents, or null when it presents none. */
function bearerToken(headers: Map<string, string>): string | null {
  const header = headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match ? match[1]! : null;
}

/** Route one request to a handler and return its response. */
function route(forge: Forge, req: HttpRequest): import('./httputil.ts').HttpResponse {
  const path = req.pathname;

  // The boot probe: no auth, always 200.
  if (path === '/healthz' && req.method === 'GET') {
    return jsonResponse(200, { ok: true, status: 'ok' });
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]!);
    const repoName = decodeURIComponent(gitMatch[2]!);
    const suffix = gitMatch[3] ?? '';
    const gitProtocol = req.headers.get('git-protocol');
    if (suffix === '/info/refs' && req.method === 'GET') {
      const service = req.search.get('service');
      if (service === 'git-upload-pack' || service === 'git-receive-pack') {
        return handleInfoRefs(forge, owner, repoName, service, gitProtocol);
      }
      return notFound('Not Found');
    }
    if (suffix === '/git-upload-pack' && req.method === 'POST') {
      return handleUploadPack(forge, owner, repoName, req.body);
    }
    if (suffix === '/git-receive-pack' && req.method === 'POST') {
      return handleReceivePack(forge, owner, repoName, req.body);
    }
    if (suffix === '/HEAD' && req.method === 'GET') {
      return binaryResponse(200, Buffer.from('ref: refs/heads/main\n', 'utf8'), 'text/plain');
    }
    return notFound('Not Found');
  }

  // REST v3.
  const rest = handleRest(forge, req);
  if (rest !== null) return rest;

  // GraphQL.
  const graphql = handleGraphQL(forge, req);
  if (graphql !== null) return graphql;

  // MCP.
  const mcp = handleMcp(forge, req);
  if (mcp !== null) return mcp;

  return notFound('Not Found');
}

/** Create the HTTP server for one forge. */
export function createApp(forge: Forge = createForge()): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = await readBody(req);
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const headers = new Map<string, string>();
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(name.toLowerCase(), value);
          else if (Array.isArray(value)) headers.set(name.toLowerCase(), value.join(', '));
        }
        const request: HttpRequest = {
          method: req.method ?? 'GET',
          pathname: url.pathname,
          search: url.searchParams,
          headers,
          body,
        };
        // Authentication: every route except /healthz needs the shop token.
        // When the environment sets no token (local practice), any non-empty
        // bearer token is accepted; a missing one is still refused.
        let response;
        if (request.pathname !== '/healthz') {
          const presented = bearerToken(headers);
          if (presented === null) {
            response = unauthorized('Requires authentication');
          } else if (forge.token !== null && presented !== forge.token) {
            response = unauthorized('Bad credentials');
          } else {
            response = route(forge, request);
          }
        } else {
          response = route(forge, request);
        }
        res.writeHead(response.status, response.headers);
        res.end(response.body);
      } catch (err) {
        // Never let one request take the server down: answer 500 and stay up.
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Internal Server Error' }));
        } else {
          res.end();
        }
      }
    })();
  });
  return server;
}
