// httputil.ts — the request/response vocabulary every handler shares.
// Written for speed on the hot path: no per-request URL object, no headers
// Map copy, no regex. Plain objects the server turns into a reply.

/** A lazily-parsed query string. Nothing is decoded until a key is asked for. */
export class FastSearchParams {
  private readonly query: string;
  private table: Map<string, string> | null = null;

  constructor(query: string) {
    this.query = query;
  }

  get(name: string): string | null {
    if (this.query.length === 0) return null;
    if (this.table === null) this.parse();
    return this.table!.get(name) ?? null;
  }

  /** The raw query string, unparsed (used to build pagination links). */
  toString(): string {
    return this.query;
  }

  /**
   * A new query string with `updates` applied on top of the current pairs.
   * Other pairs are kept, in order; updated keys keep their first position.
   */
  with(updates: Record<string, string>): string {
    const pairs: Array<[string, string]> = [];
    const seen = new Set<string>();
    if (this.query.length > 0) {
      for (const part of this.query.split('&')) {
        if (part.length === 0) continue;
        const eq = part.indexOf('=');
        const key = eq < 0 ? unescape(part) : unescape(part.slice(0, eq));
        const value = eq < 0 ? '' : unescape(part.slice(eq + 1));
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push([key, value]);
        }
      }
    }
    for (const [key, value] of Object.entries(updates)) {
      const at = pairs.findIndex(([k]) => k === key);
      if (at >= 0) pairs[at]![1] = value;
      else pairs.push([key, value]);
    }
    return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }

  private parse(): void {
    const map = new Map<string, string>();
    for (const part of this.query.split('&')) {
      if (part.length === 0) continue;
      const eq = part.indexOf('=');
      if (eq < 0) {
        if (!map.has(unescape(part))) map.set(unescape(part), '');
      } else {
        const key = unescape(part.slice(0, eq));
        if (!map.has(key)) map.set(key, unescape(part.slice(eq + 1)));
      }
    }
    this.table = map;
  }
}

/** Percent-decode one query component, treating '+' as a space (form encoding). */
function unescape(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/**
 * A zero-copy view over incoming headers. Header names are already
 * lowercased (by node:http before, by the raw server now), so lookups go
 * straight to the raw object — no Object.entries, no Map built per request.
 * The source is a plain record: node:http's IncomingHttpHeaders is the
 * same shape, and the raw server builds one by lowercasing names itself.
 */
export class IncomingHeadersMap {
  private readonly source: Record<string, string | string[] | undefined>;

  constructor(source: Record<string, string | string[] | undefined>) {
    this.source = source;
  }

  get(name: string): string | undefined {
    const value = this.source[name.toLowerCase()];
    if (value === undefined) return undefined;
    return typeof value === 'string' ? value : value.join(', ');
  }

  has(name: string): boolean {
    return this.source[name.toLowerCase()] !== undefined;
  }
}

export interface HttpRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: FastSearchParams;
  readonly headers: IncomingHeadersMap;
  readonly body: Buffer;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

// The request-id prefix only changes once a second, so cache its base-36
// form instead of converting Date.now() on every request.
let seq = 1;
let cachedSecond = 0;
let cachedSecond36 = '';

/** A unique request id for the X-GitHub-Request-Id header (never empty). */
export function nextRequestId(): string {
  const nowSec = (Date.now() / 1000) | 0;
  if (nowSec !== cachedSecond) {
    cachedSecond = nowSec;
    cachedSecond36 = nowSec.toString(36);
  }
  return `req-${cachedSecond36}-${(seq++).toString(36)}`;
}

/** A JSON response with the given status and a fresh request id. */
export function jsonResponse(
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', 'X-GitHub-Request-Id': nextRequestId(), ...extraHeaders },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

/** A plain-text response with the given status and content type. */
export function textResponse(
  status: number,
  text: string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): HttpResponse {
  return {
    status,
    headers: { 'content-type': contentType, 'X-GitHub-Request-Id': nextRequestId(), ...extraHeaders },
    body: Buffer.from(text, 'utf8'),
  };
}

/** A binary response with the given status and content type. */
export function binaryResponse(
  status: number,
  body: Buffer,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): HttpResponse {
  return {
    status,
    headers: { 'content-type': contentType, 'X-GitHub-Request-Id': nextRequestId(), ...extraHeaders },
    body,
  };
}

/** A JSON 404 with a message, the shape every unknown route and missing object uses. */
export function notFound(message: string): HttpResponse {
  return jsonResponse(404, { message });
}

/** A JSON 400 with a message, for a malformed body. */
export function badRequest(message: string): HttpResponse {
  return jsonResponse(400, { message });
}

/** A JSON 401 with a message, for a missing or wrong bearer token. */
export function unauthorized(message: string): HttpResponse {
  return jsonResponse(401, { message });
}

/** A JSON 422 with a message, for a semantic validation failure. */
export function unprocessable(message: string): HttpResponse {
  return jsonResponse(422, { message });
}
