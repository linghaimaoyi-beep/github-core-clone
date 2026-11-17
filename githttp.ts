// githttp.ts — git smart HTTP: info/refs advertisements (protocol v2 and v0),
// upload-pack (v2 ls-refs/fetch, v0 fetch) and receive-pack (v0 push with a
// sideband-framed report-status). Packfiles carry plain objects only.

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

/** Split `pack` into sideband band-1 pkt-lines. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
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

/** The refs a repo advertises, in git's order: HEAD, branches, tags. */
function advertisedRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  lines.push({
    name: 'HEAD',
    oid: mainTip ?? ZERO_OID,
    symrefTarget: `refs/heads/${repo.defaultBranch}`,
    unborn: mainTip === undefined,
  });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { name, oid };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
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

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    Buffer.from('0000', 'ascii'),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    Buffer.from('0000', 'ascii'),
  ]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const capabilities =
    service === 'git-receive-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} report-status side-band-64k delete-refs agent=${AGENT}`
      : `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
  const refs = advertisedRefs(repo);
  if (repo.refs.size === 0) {
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
  forge: Forge,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocol: string | undefined,
): HttpResponse {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return notFound('Not Found');
  if (service === 'git-receive-pack') {
    return binaryResponse(200, v0Advertisement(repo, service), 'application/x-git-receive-pack-advertisement');
  }
  if (gitProtocol === 'version=2') {
    return binaryResponse(200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
  }
  return binaryResponse(200, v0Advertisement(repo, service), 'application/x-git-upload-pack-advertisement');
}

// -------------------------------------------------------------------------------------------
// upload-pack: v2 ls-refs
// -------------------------------------------------------------------------------------------

function handleLsRefs(repo: Repo, lines: string[]): Buffer {
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
  const refs = advertisedRefs(repo);
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.size === 0) {
    // An empty repo: only the unborn HEAD, and only when the caller asked for
    // unborn refs (or when no prefix filters it out).
    if (unborn && keep('HEAD')) {
      out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
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
      out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  out.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(out);
}

// -------------------------------------------------------------------------------------------
// upload-pack: fetch (shared planning for v2 and v0)
// -------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

/** Resolve tag wants to their target commits; the tag objects ride along. */
function resolveWants(repo: Repo, wants: string[]): { commits: string[]; tags: string[] } {
  const commits: string[] = [];
  const tags: string[] = [];
  for (const want of wants) {
    if (!isObjectId(want)) continue;
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      tags.push(want);
      let target = parseTag(object.data).object;
      for (let depth = 0; depth < 8; depth += 1) {
        const targetObject = repo.objects.get(target);
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

function planObjects(
  repo: Repo,
  request: FetchRequest,
): { objects: GitObject[]; newShallow: string[]; unshallow: string[]; acks: string[]; nak: boolean } {
  const { commits, tags } = resolveWants(repo, request.wants);
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const plan = planFetch(commits, request.haves, request.shallow, request.depth, lookup);
  const roots = [...plan.commits, ...tags];
  // Only the planned commits and their trees/blobs: never a parent the
  // client already holds (an incremental or shallow fetch must not re-send
  // history).
  const reachable = collectFetchObjects(roots, lookup);
  // Never re-send what the client already holds. A have that is not itself
  // a shallow boundary means the client holds that commit's whole closure
  // (trees, blobs and ancestors); a shallow-boundary have means the client
  // holds just that commit and its own tree and blobs.
  const shallowSet = new Set(request.shallow);
  for (const have of request.haves) {
    if (shallowSet.has(have)) {
      for (const oid of collectFetchObjects([have], lookup)) reachable.delete(oid);
    } else {
      for (const oid of collectReachable([have], lookup)) reachable.delete(oid);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of reachable) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  // Acknowledgments: ACK every have that is an ancestor of (or equal to) a
  // want; NAK when none qualifies.
  const acks: string[] = [];
  for (const have of request.haves) {
    if (!repo.objects.has(have)) continue;
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
        const object = repo.objects.get(current);
        if (!object || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) stack.push(parent);
      }
      if (qualifies) break;
    }
    if (qualifies) acks.push(have);
  }
  return { objects, newShallow: plan.newShallow, unshallow: plan.unshallow, acks, nak: acks.length === 0 };
}

function buildV2FetchResponse(
  repo: Repo,
  request: FetchRequest,
): Buffer {
  const { objects, newShallow, unshallow, acks, nak } = planObjects(repo, request);
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
  if (objects.length > 0) {
    const pack = writePack(objects);
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(Buffer.from('0000', 'ascii'));
  } else {
    parts.push(Buffer.from('0000', 'ascii'));
  }
  return Buffer.concat(parts);
}

function buildV0FetchResponse(repo: Repo, request: FetchRequest): Buffer {
  const { objects, newShallow, unshallow, acks, nak } = planObjects(repo, request);
  const parts: Buffer[] = [];
  if (nak) parts.push(pktLine('NAK\n'));
  else for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (objects.length > 0) {
    parts.push(sidebandPack(writePack(objects)));
  }
  return Buffer.concat(parts);
}

export function handleUploadPack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
): HttpResponse {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return notFound('Not Found');
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
      return binaryResponse(200, handleLsRefs(repo, args), 'application/x-git-upload-pack-result');
    }
    if (command === 'fetch') {
      const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined };
      for (const arg of args) {
        if (arg.startsWith('want ')) request.wants.push(arg.slice(5));
        else if (arg.startsWith('have ')) request.haves.push(arg.slice(5));
        else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8));
        else if (arg.startsWith('deepen ')) request.depth = Number.parseInt(arg.slice(7), 10);
      }
      return binaryResponse(200, buildV2FetchResponse(repo, request), 'application/x-git-upload-pack-result');
    }
    return binaryResponse(400, Buffer.from(`unknown v2 command ${JSON.stringify(command)}`, 'utf8'), 'text/plain');
  }
  // Protocol v0: two sections split by a flush. Section one holds wants,
  // shallow and deepen; section two holds haves and done.
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // The first want may carry capabilities after a space: "want <oid> cap1 cap2".
      request.wants.push(line.slice(5, 45));
    } else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('have ')) request.haves.push(line.slice(5));
    void section;
  }
  return binaryResponse(200, buildV0FetchResponse(repo, request), 'application/x-git-upload-pack-result');
}

// -------------------------------------------------------------------------------------------
// receive-pack: push
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
): HttpResponse {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return notFound('Not Found');
  // Do NOT decode the whole body as pkt-lines: after the command section's
  // flush packet the body continues with the binary packfile, which is not
  // pkt-line framed. The byte scan below stops at the flush and hands the
  // rest to the pack reader.
  // Commands run up to the first flush packet; the rest of the body is the
  // packfile. Scan byte by byte so the pack offset is exact.
  const commands: PushCommand[] = [];
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
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
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
      const current = repo.refs.get(command.ref);
      let ok = false;
      let reason = 'non-fast-forward';
      if (command.newOid === ZERO_OID) {
        // Delete: the old value must match the ref.
        if (current !== undefined && current === command.oldOid) {
          repo.refs.delete(command.ref);
          ok = true;
        }
      } else if (command.oldOid === ZERO_OID) {
        // Create: the ref must not exist, and the new object must be present.
        if (current === undefined && repo.objects.has(command.newOid)) {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        }
      } else if (current === command.oldOid) {
        // Update: the new commit must be a descendant of the old one, unless
        // the ref is a tag (tags have no fast-forward rule).
        if (command.ref.startsWith('refs/tags/')) {
          if (repo.objects.has(command.newOid)) {
            repo.refs.set(command.ref, command.newOid);
            ok = true;
          }
        } else if (forge.isAncestor(repo, command.oldOid, command.newOid)) {
          repo.refs.set(command.ref, command.newOid);
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
    const chunk = report.subarray(cursor, Math.min(report.length, cursor + SIDEBAND_CHUNK));
    outer.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return binaryResponse(200, Buffer.concat(outer), 'application/x-git-receive-pack-result');
}
