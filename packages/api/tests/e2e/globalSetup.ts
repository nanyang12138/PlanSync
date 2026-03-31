import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(__dirname, '../../../..');
const PS_ADMIN = path.join(ROOT, 'bin/ps-admin');
const PORT = Number(process.env.PORT || 3001);

/**
 * Parse the root .env file and expand simple ${VAR} and $VAR references.
 * Returns a flat key→value map (does not override existing process.env).
 */
function loadDotEnv(): Record<string, string> {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return {};
  const result: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    // Expand ${VAR} and $VAR using process.env + already-parsed keys
    const value = raw.replace(
      /\$\{?([A-Za-z_]\w*)\}?/g,
      (_, v) => process.env[v] ?? result[v] ?? '',
    );
    if (key && !(key in process.env)) result[key] = value;
  }
  return result;
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const url = `http://localhost:${port}/api/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { status: string };
        if (data.status === 'ok') return;
      }
    } catch {
      // ignore fetch errors, retry below
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server at ${url} did not become healthy in ${timeoutMs}ms`);
}

export async function setup(): Promise<void> {
  // Check if server is already running
  try {
    const res = await fetch(`http://localhost:${PORT}/api/health`);
    const data = (await res.json()) as { status: string };
    if (data.status === 'ok') {
      console.log(`\n✅ E2E: PlanSync API already running at http://localhost:${PORT}\n`);
      return;
    }
  } catch {
    // server not running yet, will start below
  }

  // Start via ps-admin (the real user startup path).
  // Merge .env values into the child's environment so that DATABASE_URL is available
  // for the `ensure_owner_runtime_ready` step inside ps-admin (which runs Prisma before
  // dev.sh gets to source .env itself).
  console.log('\n⏳ E2E: Starting PlanSync API via ps-admin start...\n');
  const envFromDotEnv = loadDotEnv();
  const child = spawn('bash', [PS_ADMIN, 'start'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...envFromDotEnv },
  });
  child.unref();

  await waitForHealth(PORT, 90_000);
  console.log(`\n✅ E2E: PlanSync API ready at http://localhost:${PORT}\n`);
}
