/**
 * Tests for R-072 — pressing ↓ from the unselected state must enter the
 * suggestion list at index 0.
 *
 * Mounting Ink to drive useInput in a unit test is fragile, so the prompt
 * component delegates the index math to a pure helper, `nextSuggestionSelectionOnDown`.
 * The React side is just `setSelIdx(nextSuggestionSelectionOnDown(...))`.
 *
 * Contract pinned down here:
 *
 *   1. With suggestions visible and `selIdx === -1` (nothing selected yet),
 *      ↓ returns 0 — i.e. selects the first suggestion. This is the bug fix:
 *      previously the prompt required `selIdx >= 0` and ↓ silently fell
 *      through to history navigation, making the suggestion list unreachable
 *      via ↓ alone.
 *   2. With a selection already active, ↓ advances by one but is bounded by
 *      `suggestionsLength - 1` (no wraparound).
 *   3. When there are no suggestions, ↓ returns null — meaning "I don't
 *      handle this keystroke, fall through to history navigation".
 */

import { describe, it, expect } from 'vitest';
import { nextSuggestionSelectionOnDown } from '../src/prompt.js';

describe('R-072 — ↓ enters suggestion list from unselected state', () => {
  it('selects index 0 when suggestions exist and selIdx is -1', () => {
    expect(nextSuggestionSelectionOnDown(-1, 3)).toBe(0);
  });

  it('selects index 0 when there is exactly one suggestion and selIdx is -1', () => {
    expect(nextSuggestionSelectionOnDown(-1, 1)).toBe(0);
  });

  it('advances by one when a suggestion is already selected', () => {
    expect(nextSuggestionSelectionOnDown(0, 3)).toBe(1);
    expect(nextSuggestionSelectionOnDown(1, 3)).toBe(2);
  });

  it('clamps at the last suggestion (no wraparound)', () => {
    expect(nextSuggestionSelectionOnDown(2, 3)).toBe(2);
    expect(nextSuggestionSelectionOnDown(4, 3)).toBe(2);
  });

  it('returns null when there are no suggestions, signalling history fallthrough', () => {
    expect(nextSuggestionSelectionOnDown(-1, 0)).toBeNull();
    expect(nextSuggestionSelectionOnDown(0, 0)).toBeNull();
  });
});
