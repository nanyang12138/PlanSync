/**
 * R-064: `!shell` command must pause/unmount the Ink prompt before spawning a
 * subprocess and resume after, otherwise the subprocess stdout and the Ink
 * frame overwrite each other in the terminal.
 *
 * Extracted into its own module so the pause-before-exec-resume-after
 * invariant can be unit tested without spinning up a real Ink instance.
 */
import { execSync } from 'child_process';
import { c } from './ui.js';

/** Subset of InkSession needed by runShellCommand. */
export interface PausableInput {
  pause(): void;
  resume(): void;
}

/** Subset of console used by runShellCommand. Allows tests to capture output. */
export interface ShellLogger {
  log: (msg: string) => void;
}

export interface ShellCmdDeps {
  rawInput: PausableInput;
  exec?: (cmd: string, opts: { encoding: 'utf8'; timeout: number }) => string;
  logger?: ShellLogger;
}

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Run a `!shell` command. Pauses the Ink prompt before invoking the child
 * process and always resumes afterwards (even on error or timeout) so the
 * prompt can re-render cleanly underneath the captured output.
 *
 * Returns true if the command was attempted, false if `cmd` was empty.
 */
export function runShellCommand(cmd: string, deps: ShellCmdDeps): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;

  const exec =
    deps.exec ??
    ((c2, opts) => execSync(c2, opts).toString());
  const logger = deps.logger ?? { log: (m: string) => console.log(m) };

  logger.log(`\n${c.dim}$ ${trimmed}${c.reset}`);

  // Pause Ink BEFORE the subprocess runs so its stdout doesn't fight with the
  // Ink frame for terminal rows. resume() is always called via finally.
  deps.rawInput.pause();
  try {
    const out = exec(trimmed, { encoding: 'utf8', timeout: DEFAULT_TIMEOUT_MS }).trim();
    if (out) logger.log(out);
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    logger.log(`${c.red}${e.stderr?.toString().trim() || e.message || 'shell command failed'}${c.reset}`);
  } finally {
    deps.rawInput.resume();
  }
  logger.log('');
  return true;
}
