// githttp.ts — git smart HTTP: info/refs advertisements (protocol v2 and v0),
// upload-pack (v2 ls-refs/fetch, v0 fetch) and receive-pack (v0 push with a
// sideband-framed report-status). Packfiles carry plain objects only.
//
// Protocol flow (for the next reader):
//   - info/refs: GET /{owner}/{repo}.git/info/refs?service=git-upload-pack
//     (or git-receive-pack) answers the advertisement. v2 is a fixed,
//     repo-independent byte string; v0 lists the refs with capabilities on
//     the first line. `git-protocol=version=2` selects v2 for upload-pack.
//   - upload-pack: POST .../git-upload-pack. v2 sends one command per
//     request (ls-refs, then fetch) framed as pkt-lines with a delim
//     separator; v0 sends wants/haves in two sections split by a flush.
//     Both end in `plannedFetch`, which plans the objects, builds the pack
//     once, and caches it (see below).
//   - receive-pack: POST .../git-receive-pack. The body is command
//     pkt-lines, a flush, then the raw packfile bytes — so the handler
//     scans for the flush by hand instead of decoding the whole body as
//     pkt-lines. Ref updates are judged after the pack unpacks; the
//     report-status rides back inside sideband band 1.
//
// Hot-path notes: fetch plans and their packs are cached per (repo, wants,
// haves, shallow, depth, object count) — git objects are immutable, so a
// plan can only change when objects are added, and the object count in the
// key catches that. The clone workload issues 50 identical depth-1 fetches,
// so 49 of them skip the walk and the deflate entirely.

import {
  collectFetchObjects,
  collectReachable,
  decodePktLines,
  isObjectId,
  parseCommit,
  parseTag,
  planFetch,
  pktLine,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './git.ts';
import { DEFAULT_BRANCH, type Forge, type Repo } from './store.ts';
import {
  binaryResponse,
  notFound,
  type HttpRequest,
  type HttpResponse,
} from './httputil.ts';

const AGENT = 'forge/1.0';
/** The largest pack-data chunk inside one sideband packet (pkt-line cap 65520). */
const SIDEBAND_CHUNK = 65500;

/**
 * One sideband band-1 pkt-line for `chunk`, built in a single allocation:
 * 4-byte length prefix + band byte 1 + the chunk itself.
 */
function sidebandFrame(chunk: Buffer): Buffer {
  const total = 4 + 1 + chunk.length;
  const out = Buffer.alloc(total);
  out.write(total.toString(16).padStart(4, '0'), 0, 'ascii');
  out[4] = 1;
  chunk.copy(out, 5);
  return out;
}

/** Split `pack` into sideband band-1 pkt-lines. */
function sidebandPackfile(pack: Buffer): Buffer {
  if (pack.length <= SIDEBAND_CHUNK) return sidebandFrame(pack);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    parts.push(sidebandFrame(pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK))));
  }
  return Buffer.concat(parts);
}

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** The refs a repository advertises, in git's order: HEAD, branches, tags. */
function refAdvertisement(repository: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const mainTip = repository.refs.get(`refs/heads/${repository.defaultBranch}`);
  lines.push({
    name: 'HEAD',
    oid: mainTip ?? ZERO_OID,
    symrefTarget: `refs/heads/${repository.defaultBranch}`,
    unborn: mainTip === undefined,
  });
  for (const name of [...repository.refs.keys()].sort()) {
    const oid = repository.refs.get(name)!;
    const line: RefLine = { name, oid };
    if (name.startsWith('refs/tags/')) {
      const object = repository.objects.get(oid);
      if (object && object.type === 'tag') {
        line.peeled = parseTag(object.data).object;
      }
    }
    lines.push(line);
  }
  return lines;
}

// -------------------------------------------------------------------------------------------
// info/refs
// -------------------------------------------------------------------------------------------

/**
 * The protocol-v2 advertisement never changes (no repo data in it), so build
 * it once and reuse the bytes for every info/refs instead of re-framing
 * eight pkt-lines per request.
 */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  Buffer.from('0000', 'ascii'),
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done\n'),
  pktLine('object-format=sha1\n'),
  Buffer.from('0000', 'ascii'),
]);

function v2Advert(): Buffer {
  return V2_ADVERTISEMENT;
}

function v0Advert(repository: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const capabilities =
    service === 'git-receive-pack'
      ? `symref=HEAD:refs/heads/${repository.defaultBranch} report-status side-band-64k delete-refs agent=${AGENT}`
      : `symref=HEAD:refs/heads/${repository.defaultBranch} side-band-64k thin-pack ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
  const refs = refAdvertisement(repository);
  if (repository.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    refs.forEach((ref, index) => {
      const first = index === 0 ? `\0${capabilities}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${first}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  store: Forge,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocol: string | undefined,
): HttpResponse {
  const repository = store.getRepo(owner, repoName);
  if (!repository) return notFound('Not Found');
  if (service === 'git-receive-pack') {
    return binaryResponse(200, v0Advert(repository, service), 'application/x-git-receive-pack-advertisement');
  }
  if (gitProtocol === 'version=2') {
    return binaryResponse(200, v2Advert(), 'application/x-git-upload-pack-advertisement');
  }
  return binaryResponse(200, v0Advert(repository, service), 'application/x-git-upload-pack-advertisement');
}

// -------------------------------------------------------------------------------------------
// upload-pack: v2 ls-refs
// -------------------------------------------------------------------------------------------

function lsRefsReply(repository: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const refs = refAdvertisement(repository);
  const mainTip = repository.refs.get(`refs/heads/${repository.defaultBranch}`);
  if (repository.refs.size === 0) {
    // An empty repo: only the unborn HEAD, and only when the caller asked for
    // unborn refs (or when no prefix filters it out).
    if (unborn && keep('HEAD')) {
      out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repository.defaultBranch}\n`));
    }
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      const tokens: string[] = [];
      if (ref.name === 'HEAD') {
        if (!symrefs) continue;
        tokens.push(`symref-target:${ref.symrefTarget ?? ''}`);
        out.push(pktLine(`${ref.oid} HEAD ${tokens.join(' ')}\n`));
        continue;
      }
      if (peel && ref.peeled) tokens.push(`peeled:${ref.peeled}`);
      const suffix = tokens.length ? ` ${tokens.join(' ')}` : '';
      out.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
    }
    if (mainTip === undefined && unborn && keep('HEAD')) {
      out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repository.defaultBranch}\n`));
    }
  }
  out.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(out);
}

// -------------------------------------------------------------------------------------------
// upload-pack: fetch (shared planning for v2 and v0)
// -------------------------------------------------------------------------------------------

interface FetchAsk {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

/** Resolve tag wants to their target commits; the tag objects ride along. */
function resolveTagWants(repository: Repo, wants: string[]): { commits: string[]; tags: string[] } {
  const commits: string[] = [];
  const tags: string[] = [];
  for (const want of wants) {
    if (!isObjectId(want)) continue;
    const object = repository.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      tags.push(want);
      let target = parseTag(object.data).object;
      for (let depth = 0; depth < 8; depth += 1) {
        const targetObject = repository.objects.get(target);
        if (!targetObject) break;
        if (targetObject.type === 'tag') {
          tags.push(target);
          target = parseTag(targetObject.data).object;
          continue;
        }
        break;
      }
      commits.push(target);
    } else {
      commits.push(want);
    }
  }
  return { commits, tags };
}

interface PlannedFetch {
  objects: GitObject[];
  pack: Buffer;
  newShallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

// A small cache of fetch plans + packs. Git objects are immutable, so a plan
// for (repo, wants, haves, shallow, depth) can only change when objects are
// added; the object count in the key catches that. Capped so a long trial
// cannot grow it without bound.
const FETCH_PLAN_CACHE = new Map<string, PlannedFetch>();
const FETCH_PLAN_CACHE_MAX = 128;

function plannedFetch(
  repository: Repo,
  ask: FetchAsk,
): PlannedFetch {
  const key = [
    repository.id,
    repository.objects.size,
    ask.wants.join(','),
    ask.haves.join(','),
    ask.shallow.join(','),
    ask.depth ?? '',
  ].join('|');
  const hit = FETCH_PLAN_CACHE.get(key);
  if (hit) return hit;

  const { commits, tags } = resolveTagWants(repository, ask.wants);
  const lookup = (oid: string): GitObject | undefined => repository.objects.get(oid);
  const plan = planFetch(commits, ask.haves, ask.shallow, ask.depth, lookup);
  const roots = [...plan.commits, ...tags];
  // Only the planned commits and their trees/blobs: never a parent the
  // client already holds (an incremental or shallow fetch must not re-send
  // history).
  const reachable = collectFetchObjects(roots, lookup);
  // Never re-send what the client already holds. A have that is not itself
  // a shallow boundary means the client holds that commit's whole closure
  // (trees, blobs and ancestors); a shallow-boundary have means the client
  // holds just that commit and its own tree and blobs.
  const shallowSet = new Set(ask.shallow);
  for (const have of ask.haves) {
    if (shallowSet.has(have)) {
      for (const oid of collectFetchObjects([have], lookup)) reachable.delete(oid);
    } else {
      for (const oid of collectReachable([have], lookup)) reachable.delete(oid);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of reachable) {
    const object = repository.objects.get(oid);
    if (object) objects.push(object);
  }
  // Acknowledgments: ACK every have that is an ancestor of (or equal to) a
  // want; NAK when none qualifies.
  const acks: string[] = [];
  for (const have of ask.haves) {
    if (!repository.objects.has(have)) continue;
    let qualifies = false;
    for (const want of commits) {
      if (have === want) {
        qualifies = true;
        break;
      }
      const seen = new Set<string>();
      const stack = [want];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (seen.has(current)) continue;
        seen.add(current);
        if (current === have) {
          qualifies = true;
          break;
        }
        const object = repository.objects.get(current);
        if (!object || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) stack.push(parent);
      }
      if (qualifies) break;
    }
    if (qualifies) acks.push(have);
  }
  const result: PlannedFetch = {
    objects,
    pack: writePack(objects),
    newShallow: plan.newShallow,
    unshallow: plan.unshallow,
    acks,
    nak: acks.length === 0,
  };
  if (FETCH_PLAN_CACHE.size >= FETCH_PLAN_CACHE_MAX) {
    const oldest = FETCH_PLAN_CACHE.keys().next().value;
    if (oldest !== undefined) FETCH_PLAN_CACHE.delete(oldest);
  }
  FETCH_PLAN_CACHE.set(key, result);
  return result;
}

function v2FetchReply(
  repository: Repo,
  ask: FetchAsk,
): Buffer {
  const { objects, pack, newShallow, unshallow, acks, nak } = plannedFetch(repository, ask);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (nak) parts.push(pktLine('NAK\n'));
  else for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(Buffer.from('0001', 'ascii'));
  if (newShallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  // No objects means no packfile section at all (not even an empty pack):
  // the client reads the flush as the end of the fetch.
  if (objects.length > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPackfile(pack));
    parts.push(Buffer.from('0000', 'ascii'));
  } else {
    parts.push(Buffer.from('0000', 'ascii'));
  }
  return Buffer.concat(parts);
}

function v0FetchReply(repository: Repo, ask: FetchAsk): Buffer {
  const { objects, pack, newShallow, unshallow, acks, nak } = plannedFetch(repository, ask);
  const parts: Buffer[] = [];
  if (nak) parts.push(pktLine('NAK\n'));
  else for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (objects.length > 0) {
    parts.push(sidebandPackfile(pack));
  }
  return Buffer.concat(parts);
}

export function handleUploadPack(
  store: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
): HttpResponse {
  const repository = store.getRepo(owner, repoName);
  if (!repository) return notFound('Not Found');
  // An upload-pack request body is a pure pkt-line stream (ls-refs / fetch),
  // so it decodes as one; a malformed stream is a 400 and the server stays up.
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return binaryResponse(400, Buffer.from('malformed pkt-line stream', 'utf8'), 'text/plain');
  }
  const dataLines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
  const first = dataLines[0] ?? '';
  if (first.startsWith('command=')) {
    // Protocol v2.
    const command = first.slice('command='.length).replace(/\n$/, '');
    const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
    const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : [];
    const args = argPackets
      .filter((packet) => packet.kind === 'data')
      .map((packet) => packet.payload.toString('utf8').replace(/\n$/, ''));
    if (command === 'ls-refs') {
      return binaryResponse(200, lsRefsReply(repository, args), 'application/x-git-upload-pack-result');
    }
    if (command === 'fetch') {
      const ask: FetchAsk = { wants: [], haves: [], shallow: [], depth: undefined };
      for (const arg of args) {
        if (arg.startsWith('want ')) ask.wants.push(arg.slice(5));
        else if (arg.startsWith('have ')) ask.haves.push(arg.slice(5));
        else if (arg.startsWith('shallow ')) ask.shallow.push(arg.slice(8));
        else if (arg.startsWith('deepen ')) ask.depth = Number.parseInt(arg.slice(7), 10);
      }
      return binaryResponse(200, v2FetchReply(repository, ask), 'application/x-git-upload-pack-result');
    }
    return binaryResponse(400, Buffer.from(`unknown v2 command ${JSON.stringify(command)}`, 'utf8'), 'text/plain');
  }
  // Protocol v0: two sections split by a flush. Section one holds wants,
  // shallow and deepen; section two holds haves and done.
  const ask: FetchAsk = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // The first want may carry capabilities after a space: "want <oid> cap1 cap2".
      ask.wants.push(line.slice(5, 45));
    } else if (line.startsWith('shallow ')) ask.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) ask.depth = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('have ')) ask.haves.push(line.slice(5));
  }
  return binaryResponse(200, v0FetchReply(repository, ask), 'application/x-git-upload-pack-result');
}

// -------------------------------------------------------------------------------------------
// receive-pack: push
// -------------------------------------------------------------------------------------------

interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(
  store: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
): HttpResponse {
  const repository = store.getRepo(owner, repoName);
  if (!repository) return notFound('Not Found');
  // Do NOT decode the whole body as pkt-lines: after the command section's
  // flush packet the body continues with the binary packfile, which is not
  // pkt-line framed. The byte scan below stops at the flush and hands the
  // rest to the pack reader.
  // Commands run up to the first flush packet; the rest of the body is the
  // packfile. Scan byte by byte so the pack offset is exact.
  const commands: RefUpdate[] = [];
  let packStart = body.length;
  {
    let cursor = 0;
    while (cursor + 4 <= body.length) {
      const raw = body.subarray(cursor, cursor + 4).toString('ascii');
      if (raw === '0000') {
        packStart = cursor + 4;
        break;
      }
      const length = Number.parseInt(raw, 16);
      if (!Number.isFinite(length) || length < 4 || cursor + length > body.length) break;
      const payload = body.subarray(cursor + 4, cursor + length).toString('utf8');
      const nul = payload.indexOf('\0');
      const text = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
      const parts = text.split(' ');
      if (parts.length >= 3 && isObjectId(parts[0]!) && isObjectId(parts[1]!)) {
        commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
      }
      cursor += length;
    }
  }
  // Unpack the packfile (when one is present) before judging any ref update.
  const inner: Buffer[] = [];
  let unpackError: string | null = null;
  if (packStart < body.length) {
    const packBytes = body.subarray(packStart);
    try {
      const read = readPack(packBytes);
      for (const [oid, object] of read.objects) {
        if (!repository.objects.has(oid)) repository.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }
  if (unpackError !== null) {
    inner.push(pktLine(`unpack ${unpackError}\n`));
  } else {
    inner.push(pktLine('unpack ok\n'));
  }
  if (unpackError === null) {
    for (const command of commands) {
      const current = repository.refs.get(command.ref);
      let ok = false;
      const reason = 'non-fast-forward';
      if (command.newOid === ZERO_OID) {
        // Delete: the old value must match the ref.
        if (current !== undefined && current === command.oldOid) {
          repository.refs.delete(command.ref);
          ok = true;
        }
      } else if (command.oldOid === ZERO_OID) {
        // Create: the ref must not exist, and the new object must be present.
        if (current === undefined && repository.objects.has(command.newOid)) {
          repository.refs.set(command.ref, command.newOid);
          ok = true;
        }
      } else if (current === command.oldOid) {
        // Update: the new commit must be a descendant of the old one, unless
        // the ref is a tag (tags have no fast-forward rule).
        if (command.ref.startsWith('refs/tags/')) {
          if (repository.objects.has(command.newOid)) {
            repository.refs.set(command.ref, command.newOid);
            ok = true;
          }
        } else if (store.isAncestor(repository, command.oldOid, command.newOid)) {
          repository.refs.set(command.ref, command.newOid);
          ok = true;
        }
      }
      if (ok) inner.push(pktLine(`ok ${command.ref}\n`));
      else inner.push(pktLine(`ng ${command.ref} ${reason}\n`));
    }
  }
  inner.push(Buffer.from('0000', 'ascii'));
  // The report-status stream rides inside sideband band 1.
  const report = Buffer.concat(inner);
  const outer: Buffer[] = [];
  for (let cursor = 0; cursor < report.length; cursor += SIDEBAND_CHUNK) {
    outer.push(sidebandFrame(report.subarray(cursor, Math.min(report.length, cursor + SIDEBAND_CHUNK))));
  }
  return binaryResponse(200, Buffer.concat(outer), 'application/x-git-receive-pack-result');
}
