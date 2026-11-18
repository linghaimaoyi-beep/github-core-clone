// main.ts — process entrypoint and lifecycle.
//
// The entrypoint does three things, in order: bind the forge server to a
// kernel-chosen port, announce that port to the environment, and then sit
// in a poll loop until the environment reports the trial finished. The
// HTTP forge itself is built by app.ts; this file only owns startup,
// registration, and shutdown.
//
// Startup contract, step by step:
//   1. MAKEFUN_ENV_URL gives the environment origin. If it is missing the
//      process has nothing to announce itself to, so it fails fast.
//   2. The server listens on port 0 so the kernel picks a free port. Port
//      8080 is the environment's own port and is never listened on here.
//   3. POST $MAKEFUN_ENV_URL/register with {"port": N}. A 200 means the
//      environment recorded this entry; a 409 means some other entry won
//      the race, and this process just waits like any other.
//   4. GET $MAKEFUN_ENV_URL/done in a loop until the body is
//      {"done": true}. The environment answers right away (false while the
//      suite is still running), so this is a poll. A slow or failed poll is
//      retried after a short backoff; the process never exits early.
//   5. Close the server and exit 0.

import { createApp, createForge } from './app.ts';

// The environment origin, with any trailing slashes stripped.
const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_ORIGIN === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** Upper bound on how long one register or done call may run. */
const CALL_TIMEOUT_MS = 30_000;
/** Backoff ladder for retries: start here, double, never exceed the cap. */
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

/** Resolve after `ms` milliseconds. */
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Backoff after the `attempt`-th failed call: exponential, capped. */
function backoffFor(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port to the environment until it is accepted. A 200 is
 * the ordinary answer; a 409 means another entry registered first, which
 * is not this process's problem. A 400 or 405 is a contract error and ends
 * the program; a network failure or any other status is retried, because
 * the environment may still be coming up.
 */
async function announcePort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(backoffFor(attempt));
  }
}

/** Poll GET /done until it reports {"done": true}; never return sooner. */
async function awaitCompletion(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_ORIGIN}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The environment is not answering yet, or the poll timed out. That
      // means it is not done, so poll again.
    }
    await pause(backoffFor(attempt));
  }
}

/** Bind, announce, then wait for the environment: the process's whole life. */
async function main(): Promise<void> {
  const server = createApp(createForge());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitCompletion();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
