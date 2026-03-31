// E2E: ps-admin CLI behavior tests
// All tests invoke `bash bin/ps-admin` as a real subprocess (no internal imports).
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const PS_ADMIN = path.join(ROOT, 'bin/ps-admin');

describe('E2E: ps-admin', () => {
  it('P1: ps-admin help → exit 0, stdout contains Usage:', () => {
    const r = spawnSync('bash', [PS_ADMIN, 'help'], { timeout: 5000, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  it('P2: ps-admin --help → exit 0, stdout contains Usage:', () => {
    const r = spawnSync('bash', [PS_ADMIN, '--help'], { timeout: 5000, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  it('P3: ps-admin unknowncmd → exit 1, stderr contains Unknown command', () => {
    const r = spawnSync('bash', [PS_ADMIN, 'unknowncmd'], { timeout: 5000, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown command');
  });

  it('P4: ps-admin start (API already running) → exit 0, stdout contains already running', () => {
    // globalSetup already started the server; ps-admin should detect it and exit 0
    const r = spawnSync('bash', [PS_ADMIN, 'start'], {
      timeout: 15000,
      encoding: 'utf8',
      env: { ...process.env },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('already running');
  });
});
