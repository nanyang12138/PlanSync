/**
 * P0-8 / closes #571 #572 #605 #608 — load-dotenv must expand
 * `${VAR}` / `$VAR` refs against the resolved environment.
 *
 * R1 update (closes #937 #943): tests use a temp .env under
 * `os.tmpdir()` instead of mutating `/workspace/.env` so an
 * interrupted test cannot clobber a developer's local config.
 *
 * R1 update (closes #936): single-quoted values must be passed
 * through verbatim — bash single-quotes never expand. New cases
 * cover both single and double quoting.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ENV_KEYS = [
  'P0_8_TEST_DATABASE_URL',
  'P0_8_TEST_PG_PORT',
  'P0_8_TEST_USER_OVERRIDE',
  'P0_8_TEST_LITERAL_REF',
  'P0_8_TEST_NEW_VAR',
  'P0_8_TEST_PASSWORD',
  'P0_8_TEST_DOUBLE_QUOTED',
  'USER',
];
const savedEnv: Record<string, string | undefined> = {};
let tmpDir: string | null = null;
let tmpEnvPath: string | null = null;

function snapshotEnv(): void {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

function writeFixtureEnv(content: string): string {
  if (!tmpDir) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-8-dotenv-'));
  }
  tmpEnvPath = path.join(tmpDir, '.env');
  fs.writeFileSync(tmpEnvPath, content);
  return tmpEnvPath;
}

function cleanupTmp(): void {
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    tmpDir = null;
    tmpEnvPath = null;
  }
}

describe('P0-8 / R1b loadDotenvFrom expands ${VAR} refs and respects quoting', () => {
  beforeEach(() => {
    snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    cleanupTmp();
    restoreEnv();
  });

  it('expands ${USER} from process.env', async () => {
    process.env.USER = 'p0-8-tester';
    const file = writeFixtureEnv(
      'P0_8_TEST_DATABASE_URL=postgresql://${USER}@localhost:15432/plansync_dev\n',
    );
    const { loadDotenvFrom } = await import('../../scripts/load-dotenv');
    loadDotenvFrom(file);
    expect(process.env.P0_8_TEST_DATABASE_URL).toBe(
      'postgresql://p0-8-tester@localhost:15432/plansync_dev',
    );
  });

  it('expands $VAR (no braces) in unquoted values', async () => {
    process.env.USER = 'p0-8-tester';
    const file = writeFixtureEnv('P0_8_TEST_USER_OVERRIDE=hello-$USER-world\n');
    const { loadDotenvFrom } = await import('../../scripts/load-dotenv');
    loadDotenvFrom(file);
    expect(process.env.P0_8_TEST_USER_OVERRIDE).toBe('hello-p0-8-tester-world');
  });

  it('falls back to other KEYs in the same .env when not in process.env', async () => {
    delete process.env.USER;
    const file = writeFixtureEnv(
      'P0_8_TEST_PG_PORT=15499\nP0_8_TEST_DATABASE_URL=postgresql://nobody@localhost:${P0_8_TEST_PG_PORT}/plansync_dev\n',
    );
    const { loadDotenvFrom } = await import('../../scripts/load-dotenv');
    loadDotenvFrom(file);
    expect(process.env.P0_8_TEST_DATABASE_URL).toBe(
      'postgresql://nobody@localhost:15499/plansync_dev',
    );
  });

  it('leaves unresolved refs verbatim so the caller can refuse to boot', async () => {
    delete process.env.UNRESOLVED_VAR;
    const file = writeFixtureEnv(
      'P0_8_TEST_LITERAL_REF=postgresql://${UNRESOLVED_VAR}@localhost/x\n',
    );
    const { loadDotenvFrom } = await import('../../scripts/load-dotenv');
    loadDotenvFrom(file);
    expect(process.env.P0_8_TEST_LITERAL_REF).toBe('postgresql://${UNRESOLVED_VAR}@localhost/x');
  });

  it('process.env wins over .env (operator export wins)', async () => {
    process.env.P0_8_TEST_NEW_VAR = 'from-shell';
    const file = writeFixtureEnv('P0_8_TEST_NEW_VAR=from-dotenv\n');
    const { loadDotenvFrom } = await import('../../scripts/load-dotenv');
    loadDotenvFrom(file);
    expect(process.env.P0_8_TEST_NEW_VAR).toBe('from-shell');
  });

  it('SINGLE-quoted values pass $ and ${VAR} through VERBATIM (bash semantics)', async () => {
    process.env.USER = 'should-not-leak';
    const file = writeFixtureEnv(
      [
        // Password contains a literal $ — must NOT be expanded.
        "P0_8_TEST_PASSWORD='pa$$word${USER}'",
      ].join('\n') + '\n',
    );
    const { loadDotenvFrom } = await import('../../scripts/load-dotenv');
    loadDotenvFrom(file);
    expect(process.env.P0_8_TEST_PASSWORD).toBe('pa$$word${USER}');
  });

  it('DOUBLE-quoted values DO expand (bash semantics)', async () => {
    process.env.USER = 'p0-8-tester';
    const file = writeFixtureEnv('P0_8_TEST_DOUBLE_QUOTED="user-${USER}-end"\n');
    const { loadDotenvFrom } = await import('../../scripts/load-dotenv');
    loadDotenvFrom(file);
    expect(process.env.P0_8_TEST_DOUBLE_QUOTED).toBe('user-p0-8-tester-end');
  });
});
