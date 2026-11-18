// rawserver.ts — a minimal HTTP/1.1 server on raw TCP (node:net).
//
// This replaces node:http for the forge. node:http's per-request cost
// (llhttp parse into an IncomingMessage, a ServerResponse, event wiring,
// the readBody promise, writeHead/end bookkeeping) is a fixed tax on
// every request, and the four timed workloads are thousands of small
// sequential requests — so that tax is the bottleneck once the handlers
// themselves are down to ~10us. This server does only what the kit's
// runner needs and nothing else:
//
//   - One socket per connection, TCP_NODELAY on (no Nagle/delayed-ACK
//     stall on small request/response pairs).
//   - Incremental parsing: headers are split out of the byte stream,
//     bodies are taken by Content-Length or by chunked framing, and
//     pipelined requests arriving in one TCP segment are all served.
//   - The handler is called synchronously with the complete request
//     (method, target, lowercased headers, body Buffer) and returns a
//     complete response; the response goes out as one socket.write of
//     headers + body, so there is no promise or event round trip per
//     request.
//   - Keep-alive by default on HTTP/1.1; `Connection: close` (or HTTP/1.0
//     without keep-alive) closes after the reply.
//   - `Expect: 100-continue` is answered at once so a client never waits
//     for its body window; HEAD replies carry headers (with the real
//     Content-Length) but no body, matching node:http.
//
// What it deliberately does not do: TLS, HTTP/2, trailers, upgrades,
// chunked *responses* (every reply here is fully buffered, so it always
// carries Content-Length), or request timeouts (the trial's requests
// finish in milliseconds).

import { createServer, type Server, type Socket } from 'node:net';
import type { HttpResponse } from './httputil.ts';

/** One complete request, handed to the handler synchronously. */
export interface RawRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** The handler: a pure function from a complete request to a complete reply. */
export type RawHandler = (req: RawRequest) => HttpResponse;

const EMPTY_BUFFER = Buffer.alloc(0);
const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');
const CONTINUE_100 = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n');

/** Standard reason phrases for every status the handlers can return. */
const REASON: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/** Largest request head accepted (headers are a few hundred bytes). */
const MAX_HEAD_BYTES = 65_536;
/** Pause reading when this much reply data is still queued in the kernel. */
const WRITE_BACKLOG_PAUSE = 1024 * 1024;

// The Date header, cached once per second: node:http sends one on every
// reply, and building it per request would cost a Date + toUTCString each.
let cachedDate = '';
let cachedDateSec = 0;

function dateHeader(): string {
  const sec = (Date.now() / 1000) | 0;
  if (sec !== cachedDateSec) {
    cachedDateSec = sec;
    cachedDate = new Date(sec * 1000).toUTCString();
  }
  return cachedDate;
}

/** The shape of a parsed request head (request line + headers). */
interface ParsedHead {
  method: string;
  url: string;
  version: string;
  headers: Record<string, string | string[] | undefined>;
  keepAlive: boolean;
  expectContinue: boolean;
  contentLength: number;
  chunked: boolean;
}

/**
 * Parse the head text (everything before the first blank line) into its
 * parts. Returns null when the request line or a header line is malformed.
 * Header names are lowercased, as node:http does; a repeated name is
 * folded into one value with ', ' (the only duplicate the runner can
 * send is none, so this is just a safe default).
 */
function parseHead(headText: string): ParsedHead | null {
  const firstCrLf = headText.indexOf('\r\n');
  const requestLine = firstCrLf === -1 ? headText : headText.slice(0, firstCrLf);
  const sp1 = requestLine.indexOf(' ');
  const sp2 = sp1 === -1 ? -1 : requestLine.indexOf(' ', sp1 + 1);
  if (sp1 === -1 || sp2 === -1) return null;
  const method = requestLine.slice(0, sp1);
  const url = requestLine.slice(sp1 + 1, sp2);
  const version = requestLine.slice(sp2 + 1);
  if (method.length === 0 || url.length === 0 || !version.startsWith('HTTP/')) return null;

  const headers: Record<string, string | string[] | undefined> = {};
  let pos = firstCrLf === -1 ? headText.length : firstCrLf + 2;
  while (pos < headText.length) {
    const eol = headText.indexOf('\r\n', pos);
    const line = eol === -1 ? headText.slice(pos) : headText.slice(pos, eol);
    pos = eol === -1 ? headText.length : eol + 2;
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const prev = headers[name];
    if (prev === undefined) headers[name] = value;
    else if (typeof prev === 'string') headers[name] = `${prev}, ${value}`;
    else headers[name] = [...prev, value];
  }

  const connection = headers['connection'];
  const connectionValue = typeof connection === 'string' ? connection.toLowerCase() : '';
  const keepAlive =
    version === 'HTTP/1.0' ? connectionValue.includes('keep-alive') : !connectionValue.includes('close');

  const lengthRaw = headers['content-length'];
  let contentLength = 0;
  if (typeof lengthRaw === 'string') {
    contentLength = parseInt(lengthRaw, 10);
    if (Number.isNaN(contentLength) || contentLength < 0) return null;
  }

  const transferEncoding = headers['transfer-encoding'];
  const chunked =
    typeof transferEncoding === 'string' && transferEncoding.toLowerCase().includes('chunked');

  const expect = headers['expect'];
  const expectContinue =
    typeof expect === 'string' && expect.toLowerCase().includes('100-continue');

  return { method, url, version, headers, keepAlive, expectContinue, contentLength, chunked };
}

/**
 * Decode a chunked body starting at `start`. Returns the body and how many
 * bytes the whole framed body consumed, or null when more data is needed.
 * A malformed size line returns a body of length -1 as a poison value the
 * caller treats as a protocol error.
 */
function decodeChunked(
  buf: Buffer,
  start: number,
): { body: Buffer; consumed: number } | null {
  const parts: Buffer[] = [];
  let pos = start;
  for (;;) {
    const lineEnd = buf.indexOf(CRLF, pos);
    if (lineEnd === -1) return null;
    const sizeText = buf.toString('latin1', pos, lineEnd).split(';')[0]!.trim();
    const size = parseInt(sizeText, 16);
    if (Number.isNaN(size) || size < 0) return { body: Buffer.alloc(0), consumed: -1 };
    if (size === 0) {
      // Terminator: the zero chunk, then any trailers, then a blank line.
      // The blank line is the first "\r\n\r\n" at or after this line's end.
      const end = buf.indexOf(HEADER_END, lineEnd);
      if (end === -1) return null;
      return { body: parts.length === 0 ? EMPTY_BUFFER : Buffer.concat(parts), consumed: end + 4 };
    }
    if (buf.length < lineEnd + 2 + size + 2) return null;
    parts.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size));
    pos = lineEnd + 2 + size + 2;
  }
}

/**
 * Write one reply. The head is one string (status line, the handler's
 * headers, a cached Date, Content-Length, Connection) and goes out in a
 * single socket.write together with the body, so a small reply is one
 * TCP segment. HEAD replies carry the head only, with the Content-Length
 * the body would have had.
 */
function writeResponse(socket: Socket, method: string, res: HttpResponse, keepAlive: boolean): void {
  const body = res.body;
  let head = `HTTP/1.1 ${res.status} ${REASON[res.status] ?? ''}\r\n`;
  for (const name of Object.keys(res.headers)) {
    head += `${name}: ${res.headers[name]}\r\n`;
  }
  head += `Date: ${dateHeader()}\r\nContent-Length: ${body.length}\r\nConnection: ${
    keepAlive ? 'keep-alive' : 'close'
  }\r\n\r\n`;
  const headBuf = Buffer.from(head, 'latin1');
  if (method === 'HEAD' || body.length === 0) {
    socket.write(headBuf);
  } else {
    socket.write(Buffer.concat([headBuf, body]));
  }
  if (!keepAlive) socket.end();
}

/** A 500 reply in the shape the old node:http error path produced. */
function internalErrorResponse(): HttpResponse {
  return {
    status: 500,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ message: 'Internal Server Error' }), 'utf8'),
  };
}

/** Serve one connection: parse requests out of the byte stream and answer them. */
function serveConnection(socket: Socket, handler: RawHandler): void {
  socket.setNoDelay(true);
  let buf = EMPTY_BUFFER;
  let closed = false;
  let paused = false;

  socket.on('error', () => {
    closed = true;
    socket.destroy();
  });
  socket.on('close', () => {
    closed = true;
  });
  socket.on('drain', () => {
    if (paused) {
      paused = false;
      socket.resume();
      processBuffer();
    }
  });
  socket.on('data', (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    processBuffer();
  });

  function processBuffer(): void {
    for (;;) {
      if (closed) return;
      const headerEnd = buf.indexOf(HEADER_END);
      if (headerEnd === -1) {
        if (buf.length > MAX_HEAD_BYTES) socket.destroy();
        return;
      }
      const head = parseHead(buf.toString('latin1', 0, headerEnd));
      if (head === null) {
        socket.destroy();
        return;
      }
      if (head.expectContinue) socket.write(CONTINUE_100);
      const bodyStart = headerEnd + 4;

      let body: Buffer;
      let consumed: number;
      if (head.chunked) {
        const decoded = decodeChunked(buf, bodyStart);
        if (decoded === null) return;
        if (decoded.consumed === -1) {
          socket.destroy();
          return;
        }
        body = decoded.body;
        consumed = decoded.consumed;
      } else if (head.contentLength > 0) {
        if (buf.length < bodyStart + head.contentLength) return;
        body = buf.subarray(bodyStart, bodyStart + head.contentLength);
        consumed = bodyStart + head.contentLength;
      } else {
        body = EMPTY_BUFFER;
        consumed = bodyStart;
      }

      let res: HttpResponse;
      try {
        res = handler({ method: head.method, url: head.url, headers: head.headers, body });
      } catch (err) {
        process.stderr.write(
          `[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        res = internalErrorResponse();
      }
      writeResponse(socket, head.method, res, head.keepAlive);

      // Drop the bytes just served. Copy the remainder (pipelined bytes)
      // so the old, larger buffer can be collected.
      const rest = buf.subarray(consumed);
      buf = rest.length === 0 ? EMPTY_BUFFER : Buffer.from(rest);

      if (!head.keepAlive) return;
      // Backpressure: if the kernel still holds a lot of reply bytes,
      // stop reading new requests until it drains.
      if (socket.writableLength > WRITE_BACKLOG_PAUSE) {
        paused = true;
        socket.pause();
        return;
      }
      if (buf.length === 0) return;
    }
  }
}

/**
 * Create the raw TCP server. Its interface matches what main.ts needs
 * from the old node:http server: listen(0), address(), close(),
 * once('error'). The handler runs synchronously per request.
 */
export function createRawServer(handler: RawHandler): Server {
  const server = createServer((socket) => {
    serveConnection(socket, handler);
  });
  return server;
}
