#!/usr/bin/env node
/**
 * R-206 L2: standalone abort-check probe.
 *
 * Invoked by Claude Code's `PreToolUse` hook before EVERY tool call (Edit,
 * Bash, Write, MCP tools, all of them). The hook contract is "exit non-zero
 * to block the tool"; we map that to "the API said this run is aborted".
 *
 * Latency budget: < 50 ms end-to-end. We therefore:
 *   - Use only node's stdlib `http` / `https` (no imports of the larger CLI).
 *   - Make exactly one GET; if it transient-fails, retry up to 3 × 100 ms.
 *   - Fail closed on persistent failure (exit 1, IDE interrupts the loop)
 *     so a broken API can't silently bypass the gate.
 *
 * Required env (set by `bin/plansync` or whatever bootstraps the agent's
 * session — Claude Code inherits them through the hook):
 *   PLANSYNC_API_URL       e.g. http://localhost:3001
 *   PLANSYNC_API_KEY       caller's API key (exec-scoped when run inside
 *                          /exec; the endpoint short-circuits to
 *                          {aborted:false, reason:'no_exec_context'} when
 *                          the key isn't exec-scoped, so the hook is a
 *                          harmless no-op outside /exec sessions)
 *
 * Optional env:
 *   PLANSYNC_USER          x-user-name header (matches the rest of the CLI)
 *
 * Exit codes:
 *   0  — API said the run is healthy, OR this is not an exec session (nothing
 *        to gate); the tool may proceed.
 *   2  — aborted (drift / paused / not_found), persistent API failure, or
 *        config error *inside an exec run*. Claude Code interrupts the tool.
 *
 * IMPORTANT (R-206): Claude Code's PreToolUse contract only BLOCKS the tool
 * when the hook exits with code **2**. Any other non-zero code is a
 * *non-blocking* warning — the tool still runs. We previously exited 1 on
 * abort, which silently downgraded the whole L2 gate to a no-op (the warning
 * showed, the tool ran anyway). We now exit 2 to actually interrupt. Because
 * this hook fires before EVERY tool call in the repo, we only escalate to a
 * blocking exit when PLANSYNC_EXEC_RUN_ID marks this as an exec session;
 * outside /exec there is no run to protect, so a config/transport failure
 * must exit 0 rather than brick every tool call in an ordinary session.
 */
import * as http from 'http';
import * as https from 'https';

const env = process.env;
const apiUrl = env.PLANSYNC_API_URL || 'http://localhost:3001';
const apiKey = env.PLANSYNC_API_KEY || '';
const user = env.PLANSYNC_USER || env.USER || '';
// Anti-downgrade marker. `/exec` injects PLANSYNC_EXEC_RUN_ID into the
// child process env (see exec-shared.mjs buildExecMcpEnv); the agent
// running *inside* that session cannot unset it (a child Bash's env
// edits don't propagate back to the parent that spawns this hook). So
// its presence is a trustworthy "this session was launched as an exec
// run" signal, independent of the API key. We use it below to detect a
// key that has been swapped down to a non-exec-scoped one.
const expectedRunId = env.PLANSYNC_EXEC_RUN_ID || '';

// PreToolUse blocking semantics: exit 2 = block the tool; anything else
// non-zero = non-blocking warning (tool runs anyway). We only want to block
// inside an exec run — outside /exec there is no run to gate, so failing
// closed there would brick every tool call in an ordinary repo session.
const BLOCK_EXIT = expectedRunId ? 2 : 0;

// Without a key we cannot meaningfully check; fail closed (inside an exec run)
// so an improperly-configured hook doesn't silently let agents through.
if (!apiKey) {
  process.stderr.write('plansync abort-check: PLANSYNC_API_KEY is not set\n');
  process.exit(BLOCK_EXIT);
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 100;
// Hard request timeout. Auth cache needs ~2s on the first call (scrypt);
// subsequent calls hit the 5-min cache and respond in < 10ms.
// 3000ms accommodates the first-call cold-start without blocking too long.
const REQUEST_TIMEOUT_MS = 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestOnce() {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL('/api/exec/abort-check', apiUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const mod = parsed.protocol === 'https:' ? https : http;
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    };
    if (user) headers['x-user-name'] = user;
    const req = mod.request(
      {
        method: 'GET',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname,
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('abort-check: request timed out'));
    });
    req.end();
  });
}

async function main() {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const { status, body } = await requestOnce();

      // 200 = healthy. Normally we exit fast without parsing the body.
      if (status === 200) {
        // Anti-downgrade (R-206): if this session was launched as an exec
        // run (PLANSYNC_EXEC_RUN_ID set) but the endpoint answers
        // `no_exec_context`, the API key in flight is NOT bound to this
        // run — the only way that happens is the exec-scoped key was
        // swapped for a plain one, silently turning this gate into a
        // permanent no-op. That is precisely the bypass we must not wave
        // through, so fail closed instead.
        if (expectedRunId) {
          let reason = '';
          try {
            const parsed = JSON.parse(body);
            if (parsed && typeof parsed.reason === 'string') reason = parsed.reason;
          } catch {
            /* unparseable 200 body — treat as healthy and fall through */
          }
          if (reason === 'no_exec_context') {
            process.stderr.write(
              'plansync abort-check: exec session (PLANSYNC_EXEC_RUN_ID set) but the API key is ' +
                'not exec-scoped — drift gate is downgraded to a no-op; failing closed\n',
            );
            process.exit(BLOCK_EXIT);
          }
        }
        process.exit(0);
      }

      // 409 = aborted. Surface the reason on stderr so Claude Code can
      // render it in the interrupt notice the user sees.
      if (status === 409) {
        let reason = 'aborted';
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed.reason === 'string') reason = parsed.reason;
          if (parsed && parsed.executionGate) reason += ` (${parsed.executionGate})`;
        } catch {
          /* ignore — fall back to generic reason */
        }
        process.stderr.write(`PlanSync execution aborted: ${reason}\n`);
        process.exit(BLOCK_EXIT);
      }

      // Any other status (401, 5xx, etc.) — treat as transient and retry.
      lastErr = new Error(`unexpected HTTP ${status}`);
    } catch (err) {
      lastErr = err;
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  // Persistent failure → fail closed so a broken API can't silently
  // bypass the gate.
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  process.stderr.write(`plansync abort-check: API unreachable (${msg}) — failing closed\n`);
  process.exit(BLOCK_EXIT);
}

void main();
