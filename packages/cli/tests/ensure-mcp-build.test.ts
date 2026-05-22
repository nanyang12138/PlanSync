/**
 * Tests for R-101: ensureMcpBuild must self-heal a missing MCP bundle
 * the same way `bin/start-mcp` does, and must be a no-op when the
 * bundle already exists.
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import {
  ensureMcpBuild,
  resolveMcpBuildPaths,
  buildEsbuildArgs,
} from '../src/ensure-mcp-build.js';

const SERVER_PATH = '/tmp/fake-repo/packages/mcp-server/dist/index.js';

describe('ensureMcpBuild', () => {
  it('skips the build when the bundle already exists', () => {
    const existsSync = vi.fn(() => true);
    const spawnSync = vi.fn(() => ({ status: 0, stderr: Buffer.alloc(0), error: undefined }));

    const result = ensureMcpBuild(SERVER_PATH, { existsSync, spawnSync });

    expect(result.built).toBe(false);
    expect(result.serverPath).toBe(SERVER_PATH);
    expect(existsSync).toHaveBeenCalledWith(SERVER_PATH);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('runs esbuild with the canonical argv when the bundle is missing', () => {
    const existsSync = vi.fn(() => false);
    const spawnSync = vi.fn(() => ({ status: 0, stderr: Buffer.alloc(0), error: undefined }));

    const result = ensureMcpBuild(SERVER_PATH, { existsSync, spawnSync });

    expect(result.built).toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(1);

    const [cmd, args, opts] = spawnSync.mock.calls[0];
    expect(typeof cmd).toBe('string');
    expect(opts).toEqual({ stdio: 'ignore' });

    const { esbuildBin, source } = resolveMcpBuildPaths(SERVER_PATH);
    expect(args[0]).toBe(esbuildBin);
    expect(args.slice(1)).toEqual(buildEsbuildArgs(SERVER_PATH));
    expect(args).toContain(source);
    expect(args).toContain('--bundle');
    expect(args).toContain('--platform=node');
    expect(args).toContain('--target=node18');
    expect(args).toContain('--format=cjs');
    expect(args).toContain('--external:pino');
    expect(args).toContain('--external:pino-pretty');
    expect(args).toContain(`--outfile=${SERVER_PATH}`);
  });

  it('throws a descriptive error when esbuild exits non-zero', () => {
    const existsSync = vi.fn(() => false);
    const spawnSync = vi.fn(() => ({
      status: 1,
      stderr: Buffer.from('boom\n'),
      error: undefined,
    }));

    expect(() => ensureMcpBuild(SERVER_PATH, { existsSync, spawnSync })).toThrow(/exited with status 1/);
  });

  it('throws when the runtime fails to spawn esbuild at all', () => {
    const existsSync = vi.fn(() => false);
    const spawnSync = vi.fn(() => ({
      status: null,
      stderr: Buffer.alloc(0),
      error: new Error('ENOENT: no such file'),
    }));

    expect(() => ensureMcpBuild(SERVER_PATH, { existsSync, spawnSync })).toThrow(
      /failed to spawn esbuild/,
    );
  });
});

describe('resolveMcpBuildPaths', () => {
  it('derives the source, project root, and esbuild bin from the server path', () => {
    const paths = resolveMcpBuildPaths(SERVER_PATH);
    expect(paths.source).toBe(path.resolve('/tmp/fake-repo/packages/mcp-server/src/index.ts'));
    expect(paths.projectRoot).toBe(path.resolve('/tmp/fake-repo'));
    expect(paths.esbuildBin).toBe(path.resolve('/tmp/fake-repo/node_modules/.bin/esbuild'));
  });
});
