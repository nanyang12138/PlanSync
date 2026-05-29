/**
 * R-206 L2: tests for `packages/cli/src/install-hook.mjs`.
 *
 * The contracts that matter:
 *   1. Default location is `<cwd>/.claude/settings.json` — the project-level
 *      file (NOT settings.local.json, NOT home). This is what teammates
 *      will pull from git, so it must be exactly that file.
 *   2. The write is idempotent — running install twice does not duplicate
 *      the entry.
 *   3. Existing hooks (other matchers / other commands in the same entry)
 *      survive both install AND uninstall.
 *   4. `--user` writes to `~/.claude/settings.json` (mocked via $HOME).
 *   5. `--ide=cursor` / `codex` / `continue` / `cline` refuses with an
 *      explanation and writes NOTHING.
 *   6. `--uninstall` removes only the PlanSync entry, keeping the rest.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = join(__dirname, '..', 'src', 'install-hook.mjs');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runScript(opts: { args?: string[]; cwd: string; home?: string }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...(opts.args ?? [])], {
      cwd: opts.cwd,
      env: { ...process.env, HOME: opts.home ?? opts.cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

function readSettings(path: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'r206-install-hook-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('install-hook.mjs — write location + idempotency + uninstall', () => {
  it('default → writes to <cwd>/.claude/settings.json (NOT settings.local.json, NOT home)', async () => {
    const r = await runScript({ cwd: tmpDir });
    expect(r.exitCode).toBe(0);

    const projectPath = join(tmpDir, '.claude', 'settings.json');
    expect(fs.existsSync(projectPath)).toBe(true);

    // settings.local.json must NOT be created — that's gitignored personal config.
    expect(fs.existsSync(join(tmpDir, '.claude', 'settings.local.json'))).toBe(false);

    const settings = readSettings(projectPath);
    expect(settings.hooks).toBeDefined();
    const pre = (settings.hooks as { PreToolUse?: unknown[] }).PreToolUse;
    expect(Array.isArray(pre)).toBe(true);
    expect(pre!.length).toBe(1);
    const entry = (pre as Array<{ matcher: string; hooks: Array<{ command: string }> }>)[0];
    expect(entry.matcher).toBe('.*');
    expect(entry.hooks[0].command).toMatch(/plansync\s+abort-check$/);
  });

  it('default install is idempotent (repeat → no second entry)', async () => {
    await runScript({ cwd: tmpDir });
    const r2 = await runScript({ cwd: tmpDir });
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toMatch(/no change/);

    const settings = readSettings(join(tmpDir, '.claude', 'settings.json'));
    const pre = (settings.hooks as { PreToolUse: unknown[] }).PreToolUse;
    expect(pre.length).toBe(1);
  });

  it('preserves existing hooks (other matchers + other commands in same entry)', async () => {
    // Seed: a settings.json with unrelated existing hooks.
    const seedDir = join(tmpDir, '.claude');
    fs.mkdirSync(seedDir, { recursive: true });
    fs.writeFileSync(
      join(seedDir, 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: 'mcp__other__.*',
                hooks: [{ type: 'command', command: 'other-tool --check' }],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const r = await runScript({ cwd: tmpDir });
    expect(r.exitCode).toBe(0);

    const settings = readSettings(join(tmpDir, '.claude', 'settings.json'));
    const pre = (settings.hooks as { PreToolUse: unknown[] }).PreToolUse as Array<{
      matcher: string;
      hooks: Array<{ command: string }>;
    }>;
    // Both the original entry and the new plansync entry must be present.
    expect(pre).toHaveLength(2);
    expect(pre.find((e) => e.hooks[0].command === 'other-tool --check')).toBeDefined();
    expect(pre.find((e) => /plansync\s+abort-check/.test(e.hooks[0].command))).toBeDefined();
  });

  it('--user writes to $HOME/.claude/settings.json (not project)', async () => {
    const homeDir = fs.mkdtempSync(join(os.tmpdir(), 'r206-home-'));
    try {
      const r = await runScript({ cwd: tmpDir, args: ['--user'], home: homeDir });
      expect(r.exitCode).toBe(0);
      expect(fs.existsSync(join(homeDir, '.claude', 'settings.json'))).toBe(true);
      // Must NOT have touched the project-level path.
      expect(fs.existsSync(join(tmpDir, '.claude', 'settings.json'))).toBe(false);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('--ide=cursor refuses with explanation and writes nothing', async () => {
    const r = await runScript({ cwd: tmpDir, args: ['--ide=cursor'] });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/only supported in Claude Code/);
    expect(r.stderr).toMatch(/cursor/);
    // No settings file created.
    expect(fs.existsSync(join(tmpDir, '.claude', 'settings.json'))).toBe(false);
  });

  it('--ide=codex / continue / cline all refuse with no file write', async () => {
    for (const ide of ['codex', 'continue', 'cline']) {
      // Fresh tmp per ide so a previous iteration can't leak state.
      const dir = fs.mkdtempSync(join(os.tmpdir(), `r206-ide-${ide}-`));
      try {
        const r = await runScript({ cwd: dir, args: [`--ide=${ide}`] });
        expect(r.exitCode).toBe(1);
        expect(fs.existsSync(join(dir, '.claude', 'settings.json'))).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('--ide=<unknown> errors out', async () => {
    const r = await runScript({ cwd: tmpDir, args: ['--ide=emacs'] });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/unknown --ide value/);
  });

  it('--uninstall removes only PlanSync entry, keeps others', async () => {
    // First, install — then add an extra hook entry — then uninstall.
    await runScript({ cwd: tmpDir });
    const settingsPath = join(tmpDir, '.claude', 'settings.json');
    const settings = readSettings(settingsPath) as {
      hooks: { PreToolUse: Array<unknown> };
    };
    settings.hooks.PreToolUse.push({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'echo unrelated' }],
    });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const r = await runScript({ cwd: tmpDir, args: ['--uninstall'] });
    expect(r.exitCode).toBe(0);

    const final = readSettings(settingsPath) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(final.hooks.PreToolUse).toHaveLength(1);
    expect(final.hooks.PreToolUse[0].hooks[0].command).toBe('echo unrelated');
  });

  it('--uninstall on fresh settings (no plansync hook present) → exit 0 + "no change"', async () => {
    const r = await runScript({ cwd: tmpDir, args: ['--uninstall'] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/no change/);
  });

  it('recognises pre-existing entries with different plansync path forms (idempotent across clones)', async () => {
    // A teammate who installed from a different clone path would see
    // their hook present. Re-running install must not add a second entry
    // even though the literal command strings differ.
    const seedDir = join(tmpDir, '.claude');
    fs.mkdirSync(seedDir, { recursive: true });
    fs.writeFileSync(
      join(seedDir, 'settings.json'),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: '.*',
                // Pre-existing entry from some other clone path.
                hooks: [{ type: 'command', command: '/old/path/bin/plansync abort-check' }],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const r = await runScript({ cwd: tmpDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/no change/);

    const settings = readSettings(join(tmpDir, '.claude', 'settings.json'));
    expect((settings.hooks as { PreToolUse: unknown[] }).PreToolUse).toHaveLength(1);
  });
});
