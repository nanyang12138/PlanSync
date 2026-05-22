/**
 * Tests for R-067 — Ink-based PromptUI must recognise bracketed-paste markers
 * (\x1b[200~ … \x1b[201~) so multi-line pastes arrive as a single submission
 * instead of being split into per-line submits at every embedded `\n`.
 *
 * Mounting Ink to drive useInput in a unit test is fragile, so we instead pin
 * down the pure state-machine helpers that the component delegates to. The
 * React side is then a straightforward `if (paste) submitPaste(paste)` call.
 *
 * Contract pinned down here:
 *
 *   1. `parseBracketedPaste` extracts a complete paste payload when both the
 *      start and end markers arrive in one chunk.
 *   2. `parseBracketedPaste` reports `pasteStarted: true` with a partial
 *      fragment when only the start marker is present, signalling that the
 *      caller should continue accumulating chunks.
 *   3. `continueBracketedPaste` joins buffered fragments with later chunks
 *      and closes the paste once the end marker arrives — including across
 *      arbitrary chunk boundaries (e.g. paste of a 100kB file).
 *   4. Multi-line content is preserved verbatim inside the paste payload.
 */

import { describe, it, expect } from 'vitest';
import {
  parseBracketedPaste,
  continueBracketedPaste,
  PASTE_START,
  PASTE_END,
  ENABLE_BRACKETED_PASTE,
  DISABLE_BRACKETED_PASTE,
} from '../src/prompt.js';

describe('R-067 — bracketed paste parsing', () => {
  it('returns the input verbatim when no paste markers are present', () => {
    const result = parseBracketedPaste('hello world');
    expect(result).toEqual({
      before: 'hello world',
      paste: null,
      pasteStarted: false,
      pasteFragment: '',
      after: '',
    });
  });

  it('extracts a complete paste when both markers arrive in one chunk', () => {
    const chunk = `${PASTE_START}line one\nline two\nline three${PASTE_END}`;
    const result = parseBracketedPaste(chunk);
    expect(result.pasteStarted).toBe(true);
    expect(result.paste).toBe('line one\nline two\nline three');
    expect(result.before).toBe('');
    expect(result.after).toBe('');
  });

  it('preserves text before and after the paste markers', () => {
    const chunk = `pre${PASTE_START}pasted${PASTE_END}post`;
    const result = parseBracketedPaste(chunk);
    expect(result.before).toBe('pre');
    expect(result.paste).toBe('pasted');
    expect(result.after).toBe('post');
  });

  it('signals an open paste when only the start marker is present', () => {
    const chunk = `${PASTE_START}partial line one\npartial line two`;
    const result = parseBracketedPaste(chunk);
    expect(result.pasteStarted).toBe(true);
    expect(result.paste).toBeNull();
    expect(result.pasteFragment).toBe('partial line one\npartial line two');
  });

  it('continueBracketedPaste keeps buffering until the end marker arrives', () => {
    const first = continueBracketedPaste('chunk-a\n', 'chunk-b\n');
    expect(first.paste).toBeNull();
    expect(first.updatedBuffer).toBe('chunk-a\nchunk-b\n');

    const second = continueBracketedPaste(first.updatedBuffer, 'chunk-c\n');
    expect(second.paste).toBeNull();
    expect(second.updatedBuffer).toBe('chunk-a\nchunk-b\nchunk-c\n');

    const third = continueBracketedPaste(second.updatedBuffer, `chunk-d${PASTE_END}`);
    expect(third.paste).toBe('chunk-a\nchunk-b\nchunk-c\nchunk-d');
    expect(third.updatedBuffer).toBe('');
    expect(third.remainder).toBe('');
  });

  it('continueBracketedPaste returns trailing input as remainder', () => {
    const result = continueBracketedPaste('hello ', `world${PASTE_END}leftover`);
    expect(result.paste).toBe('hello world');
    expect(result.remainder).toBe('leftover');
  });

  it('exposes the enable/disable escape sequences expected by xterm-like terminals', () => {
    // The actual byte sequences matter: anything else and the terminal will
    // not switch into bracketed paste mode (or will leave it stuck after the
    // process exits).
    expect(ENABLE_BRACKETED_PASTE).toBe('\x1b[?2004h');
    expect(DISABLE_BRACKETED_PASTE).toBe('\x1b[?2004l');
    expect(PASTE_START).toBe('\x1b[200~');
    expect(PASTE_END).toBe('\x1b[201~');
  });

  it('handles a multi-line paste that contains both newline and tab characters', () => {
    const payload = 'first\n\tindented\n\nblank-above';
    const chunk = `${PASTE_START}${payload}${PASTE_END}`;
    const result = parseBracketedPaste(chunk);
    expect(result.paste).toBe(payload);
  });
});
