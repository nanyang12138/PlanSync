/**
 * Tests for R-068 — InkSession must degrade to a plain readline reader
 * when stdin is not a TTY (piped input, CI runs, scripted tests). Without
 * this fallback, Ink hangs because raw mode is unavailable.
 *
 * Mounting Ink in unit tests is fragile, so we exercise the contract via:
 *
 *   1. The pure {@link readSingleLine} helper that the fallback delegates
 *      to. It must resolve to the typed line, to the typed-but-empty line
 *      when the user hits Enter on a blank prompt, and to `null` when the
 *      input stream closes before any newline arrives (EOF).
 *
 *   2. {@link InkSession.start} which pins the fallback decision based on
 *      `process.stdin.isTTY` at the time of the call — matching the
 *      RawInput semantics so both classes agree on when to skip Ink.
 *
 *   3. {@link InkSession.nextLine} routes to the readline reader (and not
 *      to Ink's render path) when fallbackMode is on. We assert this by
 *      driving stdin from a PassThrough and observing nextLine resolves
 *      with the line we pushed — with no Ink mount ever happening.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { readSingleLine, InkSession } from '../src/prompt.js';

// ─── readSingleLine helper ────────────────────────────────────────────────────

describe('R-068 — readSingleLine helper', () => {
  it('resolves with the typed line when the user presses Enter', async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const pending = readSingleLine('> ', input, output);
    input.write('hello world\n');

    await expect(pending).resolves.toBe('hello world');
  });

  it('resolves with an empty string for a blank line + Enter', async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const pending = readSingleLine('> ', input, output);
    input.write('\n');

    await expect(pending).resolves.toBe('');
  });

  it('resolves to null when the stream closes before any line arrives (EOF)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const pending = readSingleLine('> ', input, output);
    input.end();

    await expect(pending).resolves.toBeNull();
  });

  it('writes the prompt to the output stream', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (buf: Buffer) => chunks.push(buf.toString('utf8')));

    const pending = readSingleLine('PROMPT> ', input, output);
    input.write('x\n');
    await pending;

    expect(chunks.join('')).toContain('PROMPT> ');
  });
});

// ─── InkSession fallback wiring ────────────────────────────────────────────────

describe('R-068 — InkSession non-TTY fallback', () => {
  const originalStdin = process.stdin;
  const originalStdinIsTTY = (process.stdin as NodeJS.ReadStream).isTTY;

  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    if (originalStdinIsTTY === undefined) {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdin as { isTTY?: boolean }).isTTY = originalStdinIsTTY;
    }
    vi.restoreAllMocks();
  });

  it('start() flips fallbackMode on when stdin is not a TTY', () => {
    const fakeStdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    fakeStdin.isTTY = false;
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

    const session = new InkSession([]);
    session.start([]);

    expect(session.isFallbackMode()).toBe(true);
  });

  it('start() leaves fallbackMode off when stdin is a TTY', () => {
    const fakeStdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    fakeStdin.isTTY = true;
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

    const session = new InkSession([]);
    session.start([]);

    expect(session.isFallbackMode()).toBe(false);
  });

  it('nextLine() in fallbackMode reads from stdin via readline without mounting Ink', async () => {
    const fakeStdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    fakeStdin.isTTY = false;
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

    const session = new InkSession([]);
    session.start([]);

    const pending = session.nextLine();
    fakeStdin.write('echo from pipe\n');

    await expect(pending).resolves.toBe('echo from pipe');
  });

  it('nextLine() in fallbackMode returns null on stdin close (EOF)', async () => {
    const fakeStdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    fakeStdin.isTTY = false;
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

    const session = new InkSession([]);
    session.start([]);

    const pending = session.nextLine();
    fakeStdin.end();

    await expect(pending).resolves.toBeNull();
  });
});
