/**
 * Tests for R-073 — `/code` exit must not clear the screen.
 *
 * The previous behaviour wrote the ANSI escape `\x1b[2J\x1b[H` to wipe the
 * terminal when a `/code` child process exited, which destroyed scrollback
 * history that the user may want to read. The fix prints a visible separator
 * instead while preserving everything that came before.
 *
 * Driving the real `child_process.spawn` exit path in a unit test is fragile
 * (it requires booting the Genie / Claude binary), so `launchCode` delegates
 * the printing to a small pure helper, `printCodeExitSeparator`, which is what
 * we cover here.
 *
 * Contract pinned down:
 *
 *   1. The helper never emits the clear-screen / cursor-home escape sequence
 *      that R-073 set out to remove.
 *   2. It writes a horizontal-rule style separator so the boundary between
 *      coding mode and terminal mode is still visually obvious.
 *   3. It still surfaces the "Returned to PlanSync Terminal" indicator so
 *      users know control has come back.
 */

import { describe, it, expect } from 'vitest';
import { printCodeExitSeparator } from '../src/exec.js';

function capture(): { writer: { write: (s: string) => void }; out: () => string } {
  const chunks: string[] = [];
  return {
    writer: { write: (s: string) => void chunks.push(s) },
    out: () => chunks.join(''),
  };
}

describe('R-073 — /code exit prints a separator instead of clearing the screen', () => {
  it('does not emit the screen-clear / cursor-home ANSI escape sequence', () => {
    const cap = capture();
    printCodeExitSeparator(cap.writer);
    const output = cap.out();

    expect(output).not.toContain('\x1b[2J');
    expect(output).not.toContain('\x1b[H');
    expect(output).not.toMatch(/\x1b\[2J\x1b\[H/);
  });

  it('emits a horizontal-rule style separator', () => {
    const cap = capture();
    printCodeExitSeparator(cap.writer);

    expect(cap.out()).toMatch(/─{10,}/);
  });

  it('still announces the return to PlanSync Terminal', () => {
    const cap = capture();
    printCodeExitSeparator(cap.writer);

    expect(cap.out()).toContain('Returned to PlanSync Terminal');
  });

  it('defaults to process.stdout when no writer is provided', () => {
    expect(() => printCodeExitSeparator()).not.toThrow();
  });
});
