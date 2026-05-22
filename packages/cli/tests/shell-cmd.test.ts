/**
 * R-064 coverage — `!shell` command pauses Ink before subprocess and
 * always resumes afterwards.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { runShellCommand, type PausableInput } from '../src/shell-cmd.js';

class FakeRawInput implements PausableInput {
  events: string[] = [];
  pause(): void {
    this.events.push('pause');
  }
  resume(): void {
    this.events.push('resume');
  }
}

interface FakeLogger {
  log: (msg: string) => void;
  output: string[];
}

function makeLogger(): FakeLogger {
  const output: string[] = [];
  return {
    output,
    log: (msg: string) => output.push(msg),
  };
}

describe('runShellCommand (R-064)', () => {
  let rawInput: FakeRawInput;
  let logger: FakeLogger;

  beforeEach(() => {
    rawInput = new FakeRawInput();
    logger = makeLogger();
  });

  it('returns false and does not pause Ink when command is empty', () => {
    const result = runShellCommand('   ', { rawInput, logger });
    expect(result).toBe(false);
    expect(rawInput.events).toEqual([]);
    expect(logger.output).toEqual([]);
  });

  it('pauses Ink BEFORE running exec and resumes AFTER on success', () => {
    const order: string[] = [];
    rawInput = new FakeRawInput();
    // Wrap pause/resume to record interleaving with exec.
    const origPause = rawInput.pause.bind(rawInput);
    const origResume = rawInput.resume.bind(rawInput);
    rawInput.pause = () => {
      order.push('pause');
      origPause();
    };
    rawInput.resume = () => {
      order.push('resume');
      origResume();
    };

    const result = runShellCommand('echo hi', {
      rawInput,
      logger,
      exec: (cmd) => {
        order.push(`exec:${cmd}`);
        return 'hi\n';
      },
    });

    expect(result).toBe(true);
    expect(order).toEqual(['pause', 'exec:echo hi', 'resume']);
    // Output should include the captured stdout.
    expect(logger.output.some((line) => line.includes('hi'))).toBe(true);
  });

  it('still calls resume() even if exec throws', () => {
    const result = runShellCommand('false', {
      rawInput,
      logger,
      exec: () => {
        const err = new Error('boom') as Error & { stderr?: string };
        err.stderr = 'kaboom';
        throw err;
      },
    });

    expect(result).toBe(true);
    // pause MUST be followed by resume even though exec threw.
    expect(rawInput.events).toEqual(['pause', 'resume']);
    // Error message should appear in output.
    expect(logger.output.some((line) => line.includes('kaboom'))).toBe(true);
  });

  it('falls back to err.message when stderr is empty', () => {
    runShellCommand('does-not-exist', {
      rawInput,
      logger,
      exec: () => {
        throw new Error('command not found');
      },
    });
    expect(rawInput.events).toEqual(['pause', 'resume']);
    expect(logger.output.some((line) => line.includes('command not found'))).toBe(true);
  });

  it('passes timeout: 15000 to exec', () => {
    let capturedOpts: { timeout: number; encoding: string } | null = null;
    runShellCommand('sleep 1', {
      rawInput,
      logger,
      exec: (_cmd, opts) => {
        capturedOpts = opts;
        return '';
      },
    });
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts!.timeout).toBe(15000);
    expect(capturedOpts!.encoding).toBe('utf8');
  });
});
