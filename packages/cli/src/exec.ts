import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { execSync, spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import { cfg, selfDir } from './config.js';
import { c, createSpinner } from './ui.js';

// ─── MCP config builder ───────────────────────────────────────────────────────

export function buildMcpConfigArg(
  runId: string,
  taskId: string,
  projectId: string,
  sessionId: string,
): string {
  const projectRoot = path.resolve(selfDir, '../../../');
  const localNodeBin = path.join(projectRoot, '.local-runtime', 'node', 'bin', 'node');
  const mcpServerDist = path.join(projectRoot, 'packages', 'mcp-server', 'dist', 'index.js');

  return JSON.stringify({
    mcpServers: {
      plansync: {
        command: localNodeBin,
        args: [mcpServerDist],
        env: {
          PLANSYNC_API_URL: process.env.PLANSYNC_API_URL ?? 'http://localhost:3001',
          PLANSYNC_API_KEY: process.env.PLANSYNC_API_KEY ?? '',
          PLANSYNC_USER: process.env.PLANSYNC_USER ?? process.env.USER ?? '',
          PLANSYNC_SECRET: process.env.PLANSYNC_SECRET ?? '',
          PLANSYNC_PROJECT: projectId,
          PLANSYNC_EXEC_RUN_ID: runId,
          PLANSYNC_EXEC_TASK_ID: taskId,
          PLANSYNC_EXEC_SESSION_ID: sessionId,
          LOG_LEVEL: 'warn',
        },
      },
    },
  });
}

// ─── Settings helpers ─────────────────────────────────────────────────────────

function getSettingsPath(): string {
  return path.join(path.resolve(selfDir, '../../../'), '.claude', 'settings.local.json');
}

function patchProjectInSettings(projectId: string): string {
  const settingsPath = getSettingsPath();
  let original = '';
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.mcpServers?.plansync?.env) {
      original = settings.mcpServers.plansync.env.PLANSYNC_PROJECT || '';
      settings.mcpServers.plansync.env.PLANSYNC_PROJECT = projectId;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
  } catch {
    /* ignore */
  }
  return original;
}

function restoreProjectInSettings(original: string): void {
  const settingsPath = getSettingsPath();
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.mcpServers?.plansync?.env) {
      settings.mcpServers.plansync.env.PLANSYNC_PROJECT = original;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
  } catch {
    /* ignore */
  }
}

// ─── Raw mode helpers ─────────────────────────────────────────────────────────

/** Disable raw mode before spawning a subprocess that needs a normal terminal. */
export function rawOff(): void {
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
  }
}

/** Re-enable raw mode after a subprocess exits. */
export function rawOn(): void {
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
    } catch {
      /* ignore */
    }
  }
}

// ─── /code command ────────────────────────────────────────────────────────────

export function launchCode(): ReturnType<typeof spawn> {
  const projectRoot = path.resolve(selfDir, '../../../');
  const original = patchProjectInSettings(cfg.project);

  console.log(`\n${c.blue}→ Entering PlanSync Coding Mode${c.reset}\n`);
  rawOff();
  const child = spawn(cfg.genieOrClaude, [], {
    stdio: 'inherit',
    env: { ...process.env },
    cwd: projectRoot,
  });

  const restore = () => {
    restoreProjectInSettings(original);
    rawOn();
  };
  child.on('close', () => {
    restore();
    // Clear any leftover output from the alternate screen restore, then print separator
    process.stdout.write('\x1b[2J\x1b[H'); // clear screen, cursor to top
    console.log(`${c.blue}← Returned to PlanSync Terminal${c.reset}\n`);
  });
  child.on('error', (err) => {
    restore();
    console.log(`\n${c.red}✗ ${err.message}${c.reset}\n`);
  });
  return child;
}

// ─── /exec command ────────────────────────────────────────────────────────────

export async function launchExec(
  taskId: string,
  apiGet: <T>(path: string) => Promise<T>,
): Promise<void> {
  let taskPack: unknown;
  try {
    taskPack = await apiGet<unknown>(`/api/projects/${cfg.project}/tasks/${taskId}/pack`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`\n${c.red}✗ Failed to fetch task pack: ${msg}${c.reset}\n`);
    return;
  }

  const pack = taskPack as { driftAlerts?: Array<{ status: string; reason: string }> };
  const openDrifts = (pack.driftAlerts ?? []).filter((d) => d.status === 'open');
  if (openDrifts.length > 0) {
    console.log(
      `\n${c.yellow}⚠ Task has ${openDrifts.length} unresolved drift alert(s). Resolve them first.${c.reset}\n`,
    );
    openDrifts.forEach((d) => console.log(`  • ${d.reason}`));
    console.log('');
    return;
  }

  const execPrompt = [
    'You are about to execute a PlanSync task. Read the task pack below carefully.',
    '',
    'IMPORTANT: Do NOT write any code yet.',
    'First enter plan mode — present your implementation approach for user approval.',
    'Only after approval: call plansync_execution_start, implement with real tools (Edit/Write/Bash), then plansync_execution_complete.',
    '',
    'FORBIDDEN: Do NOT call plansync_plan_create, plansync_plan_propose, or plansync_plan_activate.',
    'A plan already exists. You are here to EXECUTE a task within the existing plan, not to create a new one.',
    '',
    'Task Pack:',
    JSON.stringify(taskPack, null, 2),
  ].join('\n');

  const projectRoot = path.resolve(selfDir, '../../../');
  const original = patchProjectInSettings(cfg.project);
  const restore = () => restoreProjectInSettings(original);

  console.log(`\n${c.blue}→ Entering PlanSync Coding Mode (task: ${taskId})${c.reset}\n`);
  rawOff();
  const child = spawn(cfg.genieOrClaude, ['-p', execPrompt], {
    stdio: 'inherit',
    env: { ...process.env },
    cwd: projectRoot,
  });

  await new Promise<void>((resolve) => {
    child.on('close', () => {
      restore();
      rawOn();
      console.log(`\n${c.blue}← Returned to PlanSync Terminal${c.reset}\n`);
      resolve();
    });
    child.on('error', (err) => {
      restore();
      rawOn();
      console.log(`\n${c.red}✗ ${err.message}${c.reset}\n`);
      resolve();
    });
  });
}

// ─── Worktree helpers ─────────────────────────────────────────────────────────

function patchTask(projectId: string, taskId: string, body: Record<string, unknown>): void {
  try {
    const url = `${cfg.apiUrl}/api/projects/${projectId}/tasks/${taskId}`;
    const bodyStr = JSON.stringify(body);
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'x-user-name': cfg.user,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      () => {
        /* response ignored */
      },
    );
    req.setTimeout(5000, () => req.destroy());
    req.on('error', () => {
      /* best-effort */
    });
    req.write(bodyStr);
    req.end();
  } catch {
    /* best-effort */
  }
}

function preserveAndRemoveWorktree(
  worktreeDir: string,
  taskId: string,
  runId: string,
  projectId: string,
  options: { autonomous?: boolean } = {},
): void {
  const projectRoot = path.resolve(selfDir, '../../../');
  try {
    const status = execSync(`git -C "${worktreeDir}" status --porcelain`, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    const wtHead = execSync(`git -C "${worktreeDir}" rev-parse HEAD`, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    const mainHead = execSync(`git rev-parse HEAD`, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();

    if (status || wtHead !== mainHead) {
      const branchName = `plansync/exec-${taskId.slice(0, 8)}-${runId.slice(-6)}`;
      if (status) {
        execSync(`git -C "${worktreeDir}" add -A`, { stdio: 'pipe' });
        execSync(`git -C "${worktreeDir}" commit -m "chore: PlanSync task execution (${taskId})"`, {
          stdio: 'pipe',
        });
      }
      execSync(`git -C "${worktreeDir}" branch "${branchName}"`, { stdio: 'pipe' });
      console.log(`\n${c.green}✓ Changes saved to branch: ${branchName}${c.reset}`);
      console.log(`  Review:  git diff HEAD...${branchName}`);
      console.log(`  Merge:   git merge ${branchName}\n`);

      // Prompt to push and create a GitHub PR (only if a remote is configured)
      let prUrl: string | undefined;
      let hasRemote = false;
      try {
        execSync(`git remote get-url origin`, { cwd: projectRoot, stdio: 'pipe' });
        hasRemote = true;
      } catch {
        /* no remote configured — skip prompt */
      }

      if (hasRemote) {
        if (options.autonomous) {
          console.log(
            `  Push & PR: git push origin ${branchName} && gh pr create --head ${branchName}\n`,
          );
        } else {
          rawOff();
          process.stdout.write(`Push to GitHub and create PR? [y/N] `);
          const readResult = spawnSync('bash', ['-c', 'read ans && printf "%s" "$ans"'], {
            stdio: ['inherit', 'pipe', 'inherit'],
          });
          rawOn();
          const answer = (readResult.stdout?.toString() ?? '').trim().toLowerCase();
          console.log();

          if (answer === 'y' || answer === 'yes') {
            try {
              execSync(`git push origin "${branchName}"`, { cwd: projectRoot, stdio: 'inherit' });

              let defaultBranch = 'master';
              try {
                defaultBranch =
                  execSync(`git rev-parse --abbrev-ref origin/HEAD`, {
                    cwd: projectRoot,
                    encoding: 'utf8',
                    stdio: 'pipe',
                  })
                    .trim()
                    .replace(/^origin\//, '') || 'master';
              } catch {
                /* fallback to master */
              }

              const prTitle = `chore: PlanSync task execution (${taskId.slice(0, 8)})`;
              const prBody = `Automated execution of PlanSync task \`${taskId}\`.\n\nCreated by PlanSync /exec.`;
              const prOutput = execSync(
                `gh pr create --head "${branchName}" --base "${defaultBranch}" --title "${prTitle}" --body "${prBody}"`,
                { encoding: 'utf8', cwd: projectRoot, stdio: 'pipe' },
              ).trim();
              prUrl = prOutput.match(/https?:\/\/\S+/)?.[0] ?? prOutput;
              if (prUrl) {
                console.log(`\n${c.green}✓ PR created: ${prUrl}${c.reset}\n`);
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.log(`${c.red}✗ Push/PR failed: ${msg}${c.reset}`);
              console.log(
                `  Run manually: git push origin ${branchName} && gh pr create --head ${branchName}\n`,
              );
            }
          }
        } // end else (interactive mode)
      }

      // Single API patch with all available data
      patchTask(projectId, taskId, {
        branchName,
        ...(prUrl ? { prUrl } : {}),
      });
    }
  } catch {
    /* best-effort */
  }

  try {
    execSync(`git worktree remove --force "${worktreeDir}"`, { cwd: projectRoot, stdio: 'pipe' });
  } catch {
    /* ignore */
  }
}

// ─── Autonomous execution prompt ─────────────────────────────────────────────

function buildAutonomousPrompt(worktreeDir: string): string {
  const projectRoot = path.resolve(worktreeDir, '../../../');
  return [
    'You are in AUTONOMOUS execution mode. Do NOT wait for user approval.',
    '',
    '⚠ CRITICAL PATH ISOLATION — read carefully:',
    `  Your working directory (worktree): ${worktreeDir}`,
    `  Main repo root (DO NOT EDIT directly): ${projectRoot}`,
    '  ALL file edits (Edit, Write) MUST use paths inside your working directory.',
    `  When Glob or Grep returns a path like "${projectRoot}/packages/foo.ts",`,
    `  you MUST use "${worktreeDir}/packages/foo.ts" instead.`,
    `  NEVER edit files whose path starts with "${projectRoot}/" — those are the main repo.`,
    '',
    '1. Call plansync_exec_context → get taskPack, confirm execMode=true',
    '2. Plan internally (no user interaction needed)',
    '3. Determine the correct test command by checking:',
    '   - package.json scripts.test',
    '   - Makefile test target',
    '   - pytest.ini / jest.config.js',
    '   - .github/workflows for test commands',
    '   - Fall back to: npm test / pytest / go test ./...',
    '4. Implement using Edit, Write, Bash, Glob, Grep tools',
    '   (all Edit/Write paths must start with your worktree dir above)',
    '5. Run tests. If they fail: fix and retry (max 3 attempts)',
    '6. Call plansync_execution_complete with SPECIFIC deliverablesMet:',
    '   GOOD: "Implemented POST /auth/login with JWT; 12/12 tests pass (npm test)"',
    '   BAD: "all done", "completed", "requirements met" → REJECTED by verifier',
    '',
    'FORBIDDEN: plansync_plan_create, plansync_plan_propose, plansync_plan_activate',
  ].join('\n');
}

// ─── Auto-exec (git worktree sandbox) ────────────────────────────────────────

export async function launchAutoExec(
  taskId: string,
  runId: string,
  projectId: string,
  _taskPack: unknown,
  options: { autonomous?: boolean } = {},
): Promise<void> {
  const projectRoot = path.resolve(selfDir, '../../../');
  const worktreeDir = path.join(projectRoot, '.plansync-exec', runId);

  try {
    execSync(`git worktree add --detach "${worktreeDir}"`, { cwd: projectRoot, stdio: 'pipe' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`\n${c.red}✗ Failed to create worktree: ${msg}${c.reset}\n`);
    return;
  }

  const sessionId = crypto.randomUUID();
  const mcpConfigArg = buildMcpConfigArg(runId, taskId, projectId, sessionId);

  const metaPath = path.join(worktreeDir, '.exec-meta.json');
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      { taskId, runId, sessionId, projectId, startedAt: new Date().toISOString() },
      null,
      2,
    ),
  );

  // Layer 2: append path constraint to worktree's CLAUDE.md so both phases are protected
  const claudeMdPath = path.join(worktreeDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    const constraint = [
      '',
      '---',
      '',
      '## EXEC WORKTREE PATH CONSTRAINT',
      '',
      'You are running inside an isolated exec worktree.',
      `Working directory: ${worktreeDir}`,
      '',
      'ALL file operations (Edit, Write) must use paths within this directory.',
      `If Glob or Grep returns a path like ${projectRoot}/packages/..., use ${worktreeDir}/packages/... instead.`,
      `NEVER edit files whose path starts with ${projectRoot}/ — those are the main repository.`,
    ].join('\n');
    fs.appendFileSync(claudeMdPath, constraint);
  }

  const phase1Prompt = options.autonomous ? buildAutonomousPrompt(worktreeDir) : 'start';
  const phase1Label = options.autonomous
    ? `Executing task autonomously (${taskId})...`
    : 'Generating implementation plan...';

  console.log(`\n${c.blue}→ Launching Genie sandbox for task ${taskId} (Run: ${runId})${c.reset}`);
  console.log(`  ${c.dim}Mode:     ${options.autonomous ? 'autonomous' : 'interactive'}${c.reset}`);
  console.log(`  ${c.dim}Worktree: ${worktreeDir}${c.reset}`);
  console.log(`  ${c.dim}Session:  ${sessionId}${c.reset}\n`);

  const spinner = createSpinner(phase1Label);
  spinner.start();

  const phase1ExitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(
      cfg.genieOrClaude,
      [
        '-p',
        phase1Prompt,
        '--session-id',
        sessionId,
        '--mcp-config',
        mcpConfigArg,
        ...(options.autonomous ? ['--dangerously-skip-permissions'] : []),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env }, cwd: worktreeDir },
    );

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    const cleanup = () => {
      spinner.stop();
      child.kill('SIGINT');
    };
    process.once('SIGINT', cleanup);

    child.on('close', (code) => {
      process.removeListener('SIGINT', cleanup);
      spinner.done(
        options.autonomous ? 'Autonomous execution complete.' : 'Plan generation complete.',
      );
      if (stdout.trim()) process.stdout.write(stdout);
      if (stderr.trim()) process.stderr.write(stderr);
      resolve(code);
    });
    child.on('error', (err) => {
      process.removeListener('SIGINT', cleanup);
      spinner.fail(`Execution failed: ${err.message}`);
      resolve(null);
    });
  });

  if (phase1ExitCode !== 0 && phase1ExitCode !== null) {
    console.log(`\n${c.yellow}⚠ Genie exited early (status ${phase1ExitCode}).${c.reset}\n`);
  }

  if (!options.autonomous) {
    // Interactive mode: resume session for human plan review
    console.log(`\n${c.blue}→ Resuming session for interactive review…${c.reset}\n`);
    rawOff();
    spawnSync(cfg.genieOrClaude, ['--resume', sessionId, '--mcp-config', mcpConfigArg], {
      stdio: 'inherit',
      env: { ...process.env },
      cwd: worktreeDir,
    });
    rawOn();
  }

  preserveAndRemoveWorktree(worktreeDir, taskId, runId, projectId, {
    autonomous: options.autonomous,
  });
  console.log(`\n${c.blue}← Genie sandbox closed (task: ${taskId}, run: ${runId})${c.reset}`);
  console.log(
    `${c.yellow}⚠ Execution was handled inside Genie.` +
      ` Do NOT call plansync_execution_complete from PlanSync Terminal —` +
      ` Genie handles it (or user exited early).${c.reset}\n`,
  );
}

// ─── Interrupted run recovery ─────────────────────────────────────────────────

export interface InterruptedExec {
  taskId: string;
  runId: string;
  sessionId: string;
  projectId: string;
  worktreeDir: string;
}

export function scanInterruptedExecs(): InterruptedExec[] {
  const projectRoot = path.resolve(selfDir, '../../../');
  const execSandboxDir = path.join(projectRoot, '.plansync-exec');
  const result: InterruptedExec[] = [];

  if (!fs.existsSync(execSandboxDir)) return result;

  for (const entry of fs.readdirSync(execSandboxDir)) {
    const dir = path.join(execSandboxDir, entry);
    const metaFile = path.join(dir, '.exec-meta.json');
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      result.push({ ...meta, worktreeDir: dir });
    } catch {
      try {
        execSync(`git worktree remove --force "${dir}"`, { cwd: projectRoot, stdio: 'pipe' });
      } catch {
        /* ignore */
      }
    }
  }
  return result;
}

export function resumeInterruptedExec(run: InterruptedExec): void {
  const mcpCfg = buildMcpConfigArg(run.runId, run.taskId, run.projectId, run.sessionId);
  console.log(`\n${c.blue}→ Resuming Genie for task ${run.taskId.slice(0, 8)}…${c.reset}\n`);
  rawOff();
  spawnSync(cfg.genieOrClaude, ['--resume', run.sessionId, '--mcp-config', mcpCfg], {
    stdio: 'inherit',
    env: { ...process.env },
    cwd: run.worktreeDir,
  });
  rawOn();
}

export function cleanupInterruptedExec(run: InterruptedExec): void {
  const projectRoot = path.resolve(selfDir, '../../../');
  try {
    const wtStatus = execSync(`git -C "${run.worktreeDir}" status --porcelain`, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    const wtHead = execSync(`git -C "${run.worktreeDir}" rev-parse HEAD`, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    const mainHead = execSync(`git rev-parse HEAD`, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();

    if (wtStatus || wtHead !== mainHead) {
      const branchName = `plansync/exec-${run.taskId.slice(0, 8)}-${run.runId.slice(-6)}`;
      if (wtStatus) {
        execSync(`git -C "${run.worktreeDir}" add -A`, { stdio: 'pipe' });
        execSync(
          `git -C "${run.worktreeDir}" commit -m "chore: PlanSync task execution (${run.taskId})"`,
          { stdio: 'pipe' },
        );
      }
      try {
        execSync(`git -C "${run.worktreeDir}" branch "${branchName}"`, { stdio: 'pipe' });
        console.log(`${c.green}✓ Changes saved to branch: ${branchName}${c.reset}`);
      } catch {
        /* branch may already exist */
      }
    }
  } catch {
    /* best-effort */
  }

  try {
    execSync(`git worktree remove --force "${run.worktreeDir}"`, {
      cwd: projectRoot,
      stdio: 'pipe',
    });
  } catch {
    /* ignore */
  }
}
