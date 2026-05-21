/**
 * Tests for R-059: CLI must surface the project's authoritative `phase`
 * straight from the API response instead of re-deriving it from the presence
 * of an active / proposed plan. Previously a project owner who had created a
 * plan but had not yet typed "close project" would see `[active]` in the
 * banner even when the API still reported `phase: 'planning'` (the phase
 * column is owner-driven, not plan-driven).
 *
 * `derivePhase` is the small pure helper that backs the fetcher; testing it
 * here guarantees that the CLI mirrors `project.phase` verbatim and only
 * falls back to `'planning'` for missing / unknown values (defensive default
 * matching the Prisma column default).
 */

import { describe, it, expect } from 'vitest';
import { derivePhase } from '../src/commands.js';

describe('derivePhase (R-059) — CLI mirrors API project.phase verbatim', () => {
  it('returns "planning" when the API reports planning even if an active plan exists', () => {
    // Regression: the old CLI logic would flip to "active" the moment a plan
    // existed. With R-059 the CLI must trust the server's phase field.
    expect(derivePhase({ phase: 'planning' })).toBe('planning');
  });

  it('returns "active" when the API reports active', () => {
    expect(derivePhase({ phase: 'active' })).toBe('active');
  });

  it('returns "completed" when the API reports completed', () => {
    expect(derivePhase({ phase: 'completed' })).toBe('completed');
  });

  it('falls back to "planning" when the phase field is missing', () => {
    expect(derivePhase({})).toBe('planning');
  });

  it('falls back to "planning" when the project response is null/undefined', () => {
    expect(derivePhase(null)).toBe('planning');
    expect(derivePhase(undefined)).toBe('planning');
  });

  it('rejects unknown phase strings and falls back to "planning"', () => {
    expect(derivePhase({ phase: 'archived' })).toBe('planning');
    expect(derivePhase({ phase: '' })).toBe('planning');
  });

  it('rejects non-string phase values and falls back to "planning"', () => {
    expect(derivePhase({ phase: 1 })).toBe('planning');
    expect(derivePhase({ phase: null })).toBe('planning');
    expect(derivePhase({ phase: true })).toBe('planning');
  });
});
