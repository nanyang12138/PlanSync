/**
 * R-101: shared "ensure MCP server dist exists" helper.
 *
 * `bin/start-mcp` already auto-builds `packages/mcp-server/dist/index.js` on
 * first run (the dist/ directory is gitignored). The CLI's own start-up path
 * (`packages/cli/src/index.ts` → `McpClient.start(cfg.mcpServer)`) used to
 * skip this step, so a freshly-cloned repo that launched the CLI before ever
 * running `bin/start-mcp` would crash with "Cannot find module dist/index.js".
 *
 * Both entry points now go through `ensureMcpBuild` so the build-on-demand
 * behaviour is identical regardless of how the MCP server is launched.
 *
 * The function is pure aside from `fs` / spawn calls and accepts an injectable
 * `builder` so unit tests can exercise the decision logic without invoking
 * esbuild.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface EnsureMcpBuildOptions {
  /** Absolute path to the expected mcp-server dist file (typically packages/mcp-server/dist/index.js). */
  serverPath: string;
  /** Absolute path to the monorepo root (where node_modules/.bin/esbuild lives). */
  projectRoot: string;
  /** Node executable to invoke esbuild with. Mirrors `bin/start-mcp`'s `$LOCAL_NODE_BIN`. */
  nodeBin: string;
  /**
   * Custom builder for tests. Returns the spawn result-like object. If
   * omitted, the real esbuild CLI is invoked via `spawnSync`.
   */
  builder?: (args: BuildInvocation) => BuildResult;
  /** Optional logger; defaults to no-op. */
  logger?: (msg: string) => void;
}

export interface BuildInvocation {
  nodeBin: string;
  esbuildBin: string;
  entry: string;
  outfile: string;
}

export interface BuildResult {
  status: number | null;
  stderr?: string;
}

export interface EnsureMcpBuildOutcome {
  /** True if a build was attempted (i.e. dist was missing). */
  built: boolean;
  /** True if the dist file exists by the time the function returns. */
  ok: boolean;
  /** Populated when ok=false. */
  error?: string;
}

function defaultBuilder(inv: BuildInvocation): BuildResult {
  const result = spawnSync(
    inv.nodeBin,
    [
      inv.esbuildBin,
      inv.entry,
      '--bundle',
      '--platform=node',
      '--target=node18',
      `--outfile=${inv.outfile}`,
      '--format=cjs',
      '--external:pino',
      '--external:pino-pretty',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return {
    status: result.status,
    stderr: result.stderr ? result.stderr.toString() : undefined,
  };
}

export function ensureMcpBuild(opts: EnsureMcpBuildOptions): EnsureMcpBuildOutcome {
  const { serverPath, projectRoot, nodeBin } = opts;
  const log = opts.logger ?? (() => {});

  if (fs.existsSync(serverPath)) {
    return { built: false, ok: true };
  }

  const esbuildBin = path.join(projectRoot, 'node_modules', '.bin', 'esbuild');
  const entry = path.join(projectRoot, 'packages', 'mcp-server', 'src', 'index.ts');

  if (!fs.existsSync(esbuildBin)) {
    return {
      built: false,
      ok: false,
      error: `MCP server dist missing at ${serverPath} and esbuild not found at ${esbuildBin} (run 'npm install' at the repo root)`,
    };
  }

  if (!fs.existsSync(entry)) {
    return {
      built: false,
      ok: false,
      error: `MCP server dist missing at ${serverPath} and entry file not found at ${entry}`,
    };
  }

  try {
    fs.mkdirSync(path.dirname(serverPath), { recursive: true });
  } catch (err: unknown) {
    return {
      built: false,
      ok: false,
      error: `Failed to create ${path.dirname(serverPath)}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  log(`Building MCP server dist at ${serverPath} (one-time, after fresh clone)...`);

  const build = (opts.builder ?? defaultBuilder)({
    nodeBin,
    esbuildBin,
    entry,
    outfile: serverPath,
  });

  if (build.status !== 0) {
    return {
      built: true,
      ok: false,
      error: `esbuild exited with status ${build.status ?? 'null'}${build.stderr ? `: ${build.stderr.trim()}` : ''}`,
    };
  }

  if (!fs.existsSync(serverPath)) {
    return {
      built: true,
      ok: false,
      error: `esbuild reported success but ${serverPath} was not produced`,
    };
  }

  return { built: true, ok: true };
}
