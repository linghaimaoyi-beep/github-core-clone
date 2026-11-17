// httputil.ts — the tiny request/response vocabulary the handlers share. No
// framework, no dependencies: plain objects the server turns into a reply.

export interface HttpRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: URLSearchParams;
  readonly headers: Map<string, string>;
  readonly body: Buffer;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

let requestCounter = 1;

/** A unique request id for the X-GitHub-Request-Id header (never empty). */
export function nextRequestId(): string {
  return `req-${Date.now().toString(36)}-${requestCounter++}`;
}

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
