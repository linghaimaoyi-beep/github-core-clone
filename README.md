# github-core-clone-01 entry

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/linghaimaoyi-beep/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/linghaimaoyi-beep/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A headless single-process GitHub-compatible git forge, written in TypeScript
on the Node 22 standard library only. No dependencies, no network access, no
external processes.

## What it serves

- **Git smart HTTP** — protocol v2 (`ls-refs`, `fetch`, shallow and deepen)
  and v0 (`upload-pack`, `receive-pack`), plain-object packfiles, annotated
  tags, fast-forward enforcement with per-ref `ok` / `ng` reports.
- **REST v3** (`/api/v3`) — repositories, branches, commits, the contents
  API, labels, issues, comments and pull requests (including squash merge).
- **GraphQL** (`/api/graphql`) — viewer, repository, issues, pull requests,
  create/close issue, create/merge pull request, add comment, `node`, and
  cursor pagination.
- **MCP** (`/mcp`) — JSON-RPC 2.0 Streamable HTTP, modern era `2026-07-28`
  (`server/discover`) and the legacy `2025-11-25` handshake, with the six
  tools the suite requires.

## Run

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the environment at
`$MAKEFUN_ENV_URL`, answers `GET /healthz`, and exits when the environment
reports done. Bearer authentication uses `$MAKEFUN_SHOP_TOKEN`; when that
variable is unset any non-empty bearer token is accepted (local practice).

## Layout

- `main.ts` — lifecycle: bind, register, poll `/done`, exit.
- `app.ts` — HTTP server, routing, auth, response helpers.
- `git.ts` — git primitives: SHA-1 object ids, pkt-lines, packfiles, tree
  and commit build/parse, fetch reachability (including shallow/deepen).
- `store.ts` — the in-memory forge: repositories, refs, objects, issues,
  pull requests, labels, comments, and the three-way merge used by squash.
- `githttp.ts` — smart-HTTP handlers (info/refs, upload-pack, receive-pack).
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — the GraphQL executor for the documents the suite sends.
- `mcp.ts` — MCP (JSON-RPC 2.0) handlers.
