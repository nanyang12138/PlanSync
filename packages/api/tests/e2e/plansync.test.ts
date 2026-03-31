// E2E: bin/plansync CLI behavior tests
// All tests invoke `bash bin/plansync` as a real subprocess (no internal imports).
// Tests that require the local runtime (.local-runtime/node) are skipped automatically if
// the runtime is not present.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(__dirname, '../../../..');
const PLANSYNC = path.join(ROOT, 'bin/plansync');
const LOCAL_NODE_BIN = path.join(ROOT, '.local-runtime/node/bin/node');
const SERVER_URL = `http://localhost:${process.env.PORT || 3001}`;

// Skip runtime-dependent tests when local runtime has not been installed yet
const hasLocalRuntime = fs.existsSync(LOCAL_NODE_BIN);
function itIfRuntime(name: string, fn: () => void | Promise<void>) {
  if (hasLocalRuntime) {
    it(name, fn);
  } else {
    it.skip(`${name} [skip: local runtime not found]`, fn);
  }
}

describe('E2E: plansync', () => {
  // ── Tests that exit before ensure_user_runtime_ready (always runnable) ──

  it('B1: plansync --help → exit 0, stdout contains Usage:', () => {
    const r = spawnSync('bash', [PLANSYNC, '--help'], { timeout: 5000, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  it('B2: plansync --host (missing value) → exit non-0, error about option', () => {
    const r = spawnSync('bash', [PLANSYNC, '--host'], { timeout: 5000, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--host');
  });

  // ── Tests that require local runtime + running API ──

  itIfRuntime('B3: plansync --host cursor → writes .cursor/mcp.json with plansync entry', () => {
    const tmpDir = fs.mkdtempSync('/tmp/plansync-e2e-cursor-');
    try {
      const r = spawnSync('bash', [PLANSYNC, '--host', 'cursor', '--dir', tmpDir], {
        timeout: 60000,
        encoding: 'utf8',
        env: { ...process.env, PLANSYNC_API_URL: SERVER_URL },
      });
      // --host cursor exits 0 after writing config (no exec into cursor)
      expect(r.status).toBe(0);

      const mcpConfigPath = path.join(tmpDir, '.cursor/mcp.json');
      expect(fs.existsSync(mcpConfigPath)).toBe(true);

      const cfg = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
      expect(cfg.mcpServers?.plansync).toBeDefined();
      expect(cfg.mcpServers.plansync.command).toContain('node');
      expect(cfg.mcpServers.plansync.args[0]).toContain('mcp-server');
      expect(cfg.mcpServers.plansync.env?.PLANSYNC_API_URL).toBe(SERVER_URL);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  itIfRuntime(
    'B4: plansync --host claude → writes ~/.claude/settings.json mcpServers.plansync',
    () => {
      const settingsPath = path.join(process.env.HOME!, '.claude/settings.json');
      const backup = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : null;
      const tmpDir = fs.mkdtempSync('/tmp/plansync-e2e-claude-');
      try {
        // Use CLAUDE_BIN=/bin/false so it doesn't actually launch claude.
        // inject_claude_settings runs BEFORE the exec, so settings.json gets written
        // even though the process ultimately exits non-zero (from /bin/false).
        spawnSync('bash', [PLANSYNC, '--host', 'claude', '--dir', tmpDir], {
          timeout: 60000,
          encoding: 'utf8',
          env: {
            ...process.env,
            PLANSYNC_API_URL: SERVER_URL,
            CLAUDE_BIN: '/bin/false',
          },
        });

        // settings.json must exist and contain the plansync MCP entry
        expect(fs.existsSync(settingsPath)).toBe(true);
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

        // The key in settings.projects is the absolute path resolved by the bash script
        // (cd "$WORK_DIR" && pwd). Check for any project key that ends with tmpDir's basename.
        const baseName = path.basename(tmpDir);
        const projKey = Object.keys(settings.projects || {}).find((k) => k.endsWith(baseName));
        expect(projKey).toBeDefined();

        const projSettings = settings.projects![projKey!];
        expect(projSettings?.mcpServers?.plansync).toBeDefined();
        expect(projSettings.mcpServers.plansync.command).toContain('node');
        expect(projSettings.mcpServers.plansync.args[0]).toContain('mcp-server');
      } finally {
        // Always restore original settings.json
        if (backup) {
          fs.writeFileSync(settingsPath, backup);
        } else if (fs.existsSync(settingsPath)) {
          fs.unlinkSync(settingsPath);
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  itIfRuntime('B5: plansync --host invalidhost → exit non-0, error contains Unknown host', () => {
    const r = spawnSync('bash', [PLANSYNC, '--host', 'invalidhost'], {
      timeout: 30000,
      encoding: 'utf8',
      env: { ...process.env, PLANSYNC_API_URL: SERVER_URL },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Unknown host');
  });
});
