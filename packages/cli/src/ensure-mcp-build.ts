/**
 * R-101: shared "build MCP server bundle if missing" helper.
 *
 * The MCP server is published as a single esbuild-bundled CJS file at
 * `packages/mcp-server/dist/index.js`. The `dist/` directory is gitignored,
 * so a fresh clone (or any developer who skipped `bash scripts/build.sh`)
 * has no bundle to spawn — the CLI / `bin/start-mcp` would then fail with
 * `MODULE_NOT_FOUND` and the user would see no useful guidance.
 *
 * `bin/start-mcp` already self-heals by running esbuild on first launch.
 * This module is the same logic, extracted so the CLI's startup path
 * (`packages/cli/src/index.ts`) can call it before `mcp.start()` and avoid
 * relying on every entry point repeating the bash incantation.
 *
 * The function is dependency-injectable for testability: callers can
 * stub `existsSync` and `spawnSync` without touching the filesystem or
 * actually running esbuild.
 */
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { cfg } from './config.js';

export interface EnsureMcpBuildDeps {
  existsSync?: (p: string) => boolean;
  spawnSync?: (
    cmd: string,
    args: readonly string[],
    opts?: { stdio?: 'ignore' | 'inherit' | 'pipe' },
  ) => Pick<SpawnSyncReturns<Buffer>, 'status' | 'stderr' | 'error'>;
}

export interface EnsureMcpBuildResult {
  /** true when the bundle was missing and we attempted to build it. */
  built: boolean;
  /** absolute path of the bundle that was checked / built. */
  serverPath: string;
}

/**
 * Resolve the locations needed to invoke esbuild for the MCP server.
 * The default `serverPath` follows `cfg.mcpServer` (which itself defaults
 * to `<repo>/packages/mcp-server/dist/index.js`); from there the source
 * file is `../src/index.ts` and the project root is three directories up.
 */
export function resolveMcpBuildPaths(serverPath: string): {
  source: string;
  projectRoot: string;
  esbuildBin: string;
} {
  const distDir = path.dirname(serverPath);
  const source = path.resolve(distDir, '..', 'src', 'index.ts');
  const projectRoot = path.resolve(distDir, '..', '..', '..');
  const esbuildBin = path.join(projectRoot, 'node_modules', '.bin', 'esbuild');
  return { source, projectRoot, esbuildBin };
}

/**
 * Build the esbuild argv used to bundle the MCP server. Kept identical to
 * the bash invocation in `bin/start-mcp` so the two entry points produce
 * byte-identical bundles.
 */
export function buildEsbuildArgs(serverPath: string): string[] {
  const { source } = resolveMcpBuildPaths(serverPath);
  return [
    source,
    '--bundle',
    '--platform=node',
    '--target=node18',
    `--outfile=${serverPath}`,
    '--format=cjs',
    '--external:pino',
    '--external:pino-pretty',
  ];
}

/**
 * If `serverPath` already exists, return immediately. Otherwise spawn
 * esbuild via the local Node runtime and bundle the MCP server. Throws
 * with a descriptive message when the build fails — callers should treat
 * a thrown error as "MCP unavailable" and degrade gracefully.
 */
export function ensureMcpBuild(
  serverPath: string = cfg.mcpServer,
  deps: EnsureMcpBuildDeps = {},
): EnsureMcpBuildResult {
  const exists = deps.existsSync ?? fs.existsSync;
  const runner = deps.spawnSync ?? spawnSync;

  if (exists(serverPath)) {
    return { built: false, serverPath };
  }

  const { esbuildBin } = resolveMcpBuildPaths(serverPath);
  const args = buildEsbuildArgs(serverPath);
  const result = runner(cfg.nodeBin, [esbuildBin, ...args], { stdio: 'ignore' });

  if (result.error) {
    throw new Error(`MCP build failed to spawn esbuild: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr =
      result.stderr instanceof Buffer ? result.stderr.toString('utf8') : String(result.stderr ?? '');
    throw new Error(
      `MCP build exited with status ${result.status ?? 'null'}${stderr ? `: ${stderr}` : ''}`,
    );
  }

  return { built: true, serverPath };
}
