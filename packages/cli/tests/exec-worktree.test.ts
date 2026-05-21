/**
 * R-061 — worktree 失败时调用 failRun
 *
 * Before R-061, a failed `git worktree add` only printed an error and
 * silently returned, leaving the already-registered execution run in
 * `running` state until the heartbeat scanner declared it stale (~5min).
 *
 * `tryCreateExecWorktree` is the small, dependency-injectable helper that
 * launchAutoExec now goes through. These tests pin its contract:
 *   • on `git worktree add` failure → call failRun with a
 *     "worktree-setup-failed: …" reason and return ok=false.
 *   • on success → leave failRun untouched and return ok=true.
 */
import { describe, it, expect, vi } from 'vitest';
import { tryCreateExecWorktree } from '../src/exec.js';

describe('tryCreateExecWorktree (R-061)', () => {
  it('calls reportFailure with worktree-setup-failed reason when git fails', () => {
    const reportFailure = vi.fn();
    const exec = vi.fn(() => {
      throw new Error('fatal: directory already exists');
    });

    const res = tryCreateExecWorktree({
      worktreeDir: '/tmp/plansync-test/.plansync-exec/run-xyz',
      projectRoot: '/tmp/plansync-test',
      projectId: 'proj-1',
      taskId: 'task-1',
      runId: 'run-xyz',
      exec,
      reportFailure,
      logger: () => {
        /* silence */
      },
    });

    expect(res).toEqual({ ok: false, reason: 'fatal: directory already exists' });
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, opts] = exec.mock.calls[0];
    expect(cmd).toContain('git worktree add --detach');
    expect(cmd).toContain('/tmp/plansync-test/.plansync-exec/run-xyz');
    expect(opts).toMatchObject({ cwd: '/tmp/plansync-test', stdio: 'pipe' });

    expect(reportFailure).toHaveBeenCalledTimes(1);
    const [projectId, taskId, runId, reason] = reportFailure.mock.calls[0];
    expect(projectId).toBe('proj-1');
    expect(taskId).toBe('task-1');
    expect(runId).toBe('run-xyz');
    expect(reason).toMatch(/^worktree-setup-failed: /);
    expect(reason).toContain('fatal: directory already exists');
  });

  it('returns ok=true and does NOT call reportFailure when git succeeds', () => {
    const reportFailure = vi.fn();
    const exec = vi.fn(() => undefined);

    const res = tryCreateExecWorktree({
      worktreeDir: '/tmp/plansync-test/.plansync-exec/run-ok',
      projectRoot: '/tmp/plansync-test',
      projectId: 'proj-1',
      taskId: 'task-1',
      runId: 'run-ok',
      exec,
      reportFailure,
      logger: () => {
        /* silence */
      },
    });

    expect(res).toEqual({ ok: true });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('coerces non-Error throws into a string reason', () => {
    const reportFailure = vi.fn();
    const exec = vi.fn(() => {
      // simulate odd library behaviour: a string thrown instead of an Error
      throw 'boom-no-stack';
    });

    const res = tryCreateExecWorktree({
      worktreeDir: '/tmp/wt',
      projectRoot: '/tmp/repo',
      projectId: 'p',
      taskId: 't',
      runId: 'r',
      exec,
      reportFailure,
      logger: () => {
        /* silence */
      },
    });

    expect(res).toEqual({ ok: false, reason: 'boom-no-stack' });
    expect(reportFailure).toHaveBeenCalledWith(
      'p',
      't',
      'r',
      'worktree-setup-failed: boom-no-stack',
    );
  });
});
