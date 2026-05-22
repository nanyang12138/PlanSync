/**
 * R-101: unit tests for ensureMcpBuild.
 *
 * Verifies that the helper:
 *   - no-ops when the dist already exists
 *   - invokes the (injected) builder when the dist is missing and reports success
 *   - surfaces an error (without throwing) when esbuild itself is missing
 *   - surfaces an error when the builder exits non-zero
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureMcpBuild, type BuildInvocation } from '../src/mcp-bootstrap.js';

let scratch: string;

function makeProjectRoot(): { projectRoot: string; entry: string; esbuildBin: string } {
  const projectRoot = scratch;
  // Create the minimum directory layout the function checks for: an entry
  // source file and a stub esbuild binary in node_modules/.bin.
  const entryDir = path.join(projectRoot, 'packages', 'mcp-server', 'src');
  fs.mkdirSync(entryDir, { recursive: true });
  const entry = path.join(entryDir, 'index.ts');
  fs.writeFileSync(entry, '// fake entry\n');
  const binDir = path.join(projectRoot, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const esbuildBin = path.join(binDir, 'esbuild');
  fs.writeFileSync(esbuildBin, '#!/bin/sh\n');
  fs.chmodSync(esbuildBin, 0o755);
  return { projectRoot, entry, esbuildBin };
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plansync-mcp-bootstrap-'));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('ensureMcpBuild (R-101)', () => {
  it('is a no-op when the dist file already exists', () => {
    const { projectRoot } = makeProjectRoot();
    const serverPath = path.join(projectRoot, 'packages', 'mcp-server', 'dist', 'index.js');
    fs.mkdirSync(path.dirname(serverPath), { recursive: true });
    fs.writeFileSync(serverPath, 'module.exports = {};\n');

    let builderCalls = 0;
    const outcome = ensureMcpBuild({
      serverPath,
      projectRoot,
      nodeBin: '/usr/bin/node',
      builder: () => {
        builderCalls += 1;
        return { status: 0 };
      },
    });

    expect(outcome).toEqual({ built: false, ok: true });
    expect(builderCalls).toBe(0);
  });

  it('invokes the builder when dist is missing and reports success when it writes the file', () => {
    const { projectRoot } = makeProjectRoot();
    const serverPath = path.join(projectRoot, 'packages', 'mcp-server', 'dist', 'index.js');

    const seenInvocations: BuildInvocation[] = [];
    const builder = (inv: BuildInvocation) => {
      seenInvocations.push(inv);
      fs.mkdirSync(path.dirname(inv.outfile), { recursive: true });
      fs.writeFileSync(inv.outfile, '// built\n');
      return { status: 0 };
    };

    const logs: string[] = [];
    const outcome = ensureMcpBuild({
      serverPath,
      projectRoot,
      nodeBin: '/usr/bin/node',
      builder,
      logger: (m) => logs.push(m),
    });

    expect(outcome).toEqual({ built: true, ok: true });
    expect(seenInvocations).toHaveLength(1);
    expect(seenInvocations[0].outfile).toBe(serverPath);
    expect(seenInvocations[0].entry).toBe(
      path.join(projectRoot, 'packages', 'mcp-server', 'src', 'index.ts'),
    );
    expect(seenInvocations[0].esbuildBin).toBe(
      path.join(projectRoot, 'node_modules', '.bin', 'esbuild'),
    );
    expect(seenInvocations[0].nodeBin).toBe('/usr/bin/node');
    expect(fs.existsSync(serverPath)).toBe(true);
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it('returns an error (without throwing) when esbuild is missing', () => {
    // Don't call makeProjectRoot: the scratch dir is empty, so the bin/esbuild
    // check should fail first.
    const projectRoot = scratch;
    const serverPath = path.join(projectRoot, 'packages', 'mcp-server', 'dist', 'index.js');

    let builderCalls = 0;
    const outcome = ensureMcpBuild({
      serverPath,
      projectRoot,
      nodeBin: '/usr/bin/node',
      builder: () => {
        builderCalls += 1;
        return { status: 0 };
      },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.built).toBe(false);
    expect(outcome.error).toMatch(/esbuild not found/);
    expect(builderCalls).toBe(0);
  });

  it('returns an error when the builder exits non-zero', () => {
    const { projectRoot } = makeProjectRoot();
    const serverPath = path.join(projectRoot, 'packages', 'mcp-server', 'dist', 'index.js');

    const outcome = ensureMcpBuild({
      serverPath,
      projectRoot,
      nodeBin: '/usr/bin/node',
      builder: () => ({ status: 1, stderr: 'boom' }),
    });

    expect(outcome.built).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/esbuild exited with status 1/);
    expect(outcome.error).toMatch(/boom/);
    expect(fs.existsSync(serverPath)).toBe(false);
  });
});
