// git.ts — git primitives: object ids, pkt-lines, packfiles, tree/commit
// build and parse, reachability, and fetch planning (including shallow and
// deepen). Standard library only. No store or HTTP knowledge lives here.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const GIT_OBJECT_FORMAT = 'sha1';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** SHA-1 of `<type> <len>\0<data>`: the object id of an object. */
export function hashObject(type: GitObjectType, data: Buffer | Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Build one object header + data into the bytes that hash to its id. */
export function objectBytes(type: GitObjectType, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'ascii'), data]);
}

// -------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  readonly kind: PktKind;
  readonly payload: Buffer;
}

/** One pkt-line framing `payload` (a payload already ending in `\n` when it is text). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error(`pkt-line of ${length} bytes exceeds 65520`);
  const prefix = Buffer.alloc(4);
  prefix.write(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, body]);
}

export const FLUSH_PKT: Buffer = Buffer.from('0000', 'ascii');
export const DELIM_PKT: Buffer = Buffer.from('0001', 'ascii');
export const RESPONSE_END_PKT: Buffer = Buffer.from('0002', 'ascii');

/** Encode a list of text lines / control markers into one pkt-line stream. */
export function encodePktLines(lines: ReadonlyArray<string | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(FLUSH_PKT);
    else if (line === 'delim') parts.push(DELIM_PKT);
    else if (line === 'response-end') parts.push(RESPONSE_END_PKT);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole pkt-line stream into packets. Throws on malformed framing. */
export function decodePktLines(body: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('pkt-line stream ends mid-length');
    const raw = body.subarray(offset, offset + 4).toString('ascii');
    if (raw === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (raw === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (raw === '0002') {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const length = Number.parseInt(raw, 16);
    if (!Number.isFinite(length) || length < 4 || length > 65520) {
      throw new Error(`bad pkt-line length ${JSON.stringify(raw)}`);
    }
    if (offset + length > body.length) throw new Error('pkt-line stream ends mid-packet');
    packets.push({ kind: 'data', payload: Buffer.from(body.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  return packets;
}

/** The text payloads of a pkt-line stream, in order, without trailing `\n`. */
export function pktTextLines(body: Buffer): string[] {
  const lines: string[] = [];
  for (const packet of decodePktLines(body)) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// -------------------------------------------------------------------------------------------
// trees and commits
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer | Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new Error(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object; refuses a malformed header layout. */
export function parseCommit(data: Buffer | Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  for (const parent of parents) if (!isObjectId(parent)) throw new Error('commit has a bad parent id');
  return { tree, parents, author, committer, message };
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author?: string;
  readonly committer?: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

export const DEFAULT_IDENTITY = 'Conformance <conformance@make.fun>';
export const DEFAULT_TIMESTAMP = 1700000000;

/** Build a commit object's bytes (the layout the conformance client itself uses). */
export function buildCommit(fields: BuildCommitFields): Buffer {
  if (!isObjectId(fields.tree)) throw new Error('buildCommit needs a valid tree id');
  const timestamp = fields.timestamp ?? DEFAULT_TIMESTAMP;
  const timezone = fields.timezone ?? '+0000';
  const who = `${fields.author ?? DEFAULT_IDENTITY} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? DEFAULT_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new Error('buildCommit needs valid parent ids');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer | Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

const CODE_TYPE: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};
const TYPE_CODE: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

/** Write one packfile entry header: varint type/size. */
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeCode = TYPE_CODE[type];
  let first = (typeCode << 4) | (size & 0x0f);
  let remaining = size >> 4;
  const bytes: number[] = [];
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let next = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** Write a packfile of plain (non-delta) objects, with a SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const header = Buffer.alloc(8);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(list.length, 4);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer | Uint8Array, delta: Buffer | Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const baseSize = readSize();
  if (baseSize !== baseBuffer.length) throw new Error('delta base size does not match');
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy size is truncated');
          copySize += deltaBuffer[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
  readonly checksumOk: boolean;
}

/** Read a packfile (version 2 or 3) and resolve every object, including deltas. */
export function readPack(pack: Buffer | Uint8Array, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computedTrailer;
  if (!checksumOk) throw new Error('pack trailer checksum does not match its bytes');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount, checksumOk };
}

// -------------------------------------------------------------------------------------------
// reachability and fetch planning
// -------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Every object reachable from `roots`: commit → tree + parents, tree → entries, tag → target. */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is an ancestor of (or equal to) `commit`. */
export function isAncestor(ancestor: string, commit: string, lookup: ObjectLookup): boolean {
  if (ancestor === commit) return true;
  const seen = new Set<string>();
  const stack = [commit];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

export interface FetchPlan {
  /** Commits to send (their trees and blobs follow by reachability). */
  readonly commits: string[];
  /** The new shallow boundaries: commits at the depth cutoff. */
  readonly newShallow: string[];
  /** Old shallow boundaries that are now fully known. */
  readonly unshallow: string[];
}

/**
 * The objects a fetch sends for a set of commits: each commit plus its tree
 * and blobs, but NOT its parents. Parents are only sent when they are
 * themselves in the set (a full clone lists every commit; an incremental
 * fetch lists only the new ones). A tag object is sent on its own; its
 * target commit is planned separately (it is in the set when it should go).
 */
export function collectFetchObjects(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      // The tree, never the parents: a parent is sent only when the plan
      // names it (it is a new commit in its own right).
      stack.push(parseCommit(object.data).tree);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
    // Tags: the tag object itself is sent; its target is not followed here.
  }
  return seen;
}

/**
 * Plan a fetch. `wants` are the tips the client wants, `haves` what it already
 * holds, `clientShallow` its current shallow boundaries, `depth` the requested
 * depth (undefined for a full fetch).
 *
 * A have that is not a shallow boundary means the client holds its whole
 * history, so neither it nor its ancestors are sent. A have that IS a shallow
 * boundary is held but its ancestors are not, so the walk passes through it.
 * The walk stops `depth` generations from a want; the commits at the cutoff
 * become the new shallow boundaries.
 */
export function planFetch(
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | undefined,
  lookup: ObjectLookup,
): FetchPlan {
  const haveSet = new Set(haves);
  const shallowSet = new Set(clientShallow);
  // The client holds a commit when it is a have. It holds that commit's whole
  // history only when the have is not itself a shallow boundary.
  const hasCommit = (oid: string): boolean => haveSet.has(oid);
  const heldHistory = (oid: string): boolean => haveSet.has(oid) && !shallowSet.has(oid);
  const commits: string[] = [];
  const sent = new Set<string>();
  // The distance (generations) of each sent commit from its nearest want.
  const sentDistance = new Map<string, number>();
  // Breadth-first walk from the wants, tracking generations from the nearest want.
  const queue: Array<{ oid: string; distance: number }> = wants
    .filter((oid) => isObjectId(oid))
    .map((oid) => ({ oid, distance: 0 }));
  const visited = new Set<string>();
  while (queue.length > 0) {
    const { oid, distance } = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    if (heldHistory(oid)) continue;
    if (depth !== undefined && distance >= depth) {
      // At the depth cutoff: not sent, and its parents not walked.
      continue;
    }
    // A have (a shallow boundary the client already holds) is not re-sent,
    // but the walk passes through it: its ancestors are not held.
    if (!hasCommit(oid) && !sent.has(oid)) {
      sent.add(oid);
      commits.push(oid);
      sentDistance.set(oid, distance);
    }
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) {
      queue.push({ oid: parent, distance: distance + 1 });
    }
  }
  // New shallow boundaries, only when a depth was asked for: the sent commits
  // at the greatest depth the fetch reached (distance depth - 1) that still
  // have a parent. The boundary is the deepest commit sent, not the first
  // commit left unsent.
  const newShallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, distance] of sentDistance) {
      if (distance !== depth - 1) continue;
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      if (parseCommit(object.data).parents.length > 0) newShallow.push(oid);
    }
  }
  // An old shallow boundary stops being one when the fetch delivered its
  // parent, so it is now fully connected.
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (!haveSet.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.every((parent) => sent.has(parent))) unshallow.push(oid);
  }
  return { commits, newShallow, unshallow };
}
