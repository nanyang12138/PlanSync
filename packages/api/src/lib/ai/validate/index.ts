// R-186: defense-in-depth validation layer for AI-generated payloads.
//
// R-185 makes structural failures unlikely (decoder-level tool_use), but
// strict mode does NOT prevent SEMANTIC hallucinations: the model can
// still return a schema-valid payload whose field values are made up
// (fabricated task ids, invented dates, fictional dollar amounts that
// were never in the input). This module is the semantic verification
// layer industry guides (tianpan.co 2026-04, Fordel Studios) recommend
// running between the zod parse and the application using the result.
//
// Three primitives, all pure functions so they can compose in any order:
//
//   * validateOrNull(raw, schema)              — parse + zod, no exceptions
//   * assertIdsInAllowlist(ids, allow, field)  — every emitted id MUST come
//                                                from the input set
//   * assertLiteralsInContext(value, ctx, fld) — literal tokens (dates,
//                                                $amounts, %numbers, quoted
//                                                strings) must appear in the
//                                                context text (AgentGuard
//                                                hallucination_proxy
//                                                heuristic)
//
// All functions return structured results (no throws); callers decide
// whether to drop, downgrade, or flag the payload — the validation layer
// must never crash the request path.

import { z } from 'zod';
import { logger } from '../../logger';

export interface ValidationOk<T> {
  ok: true;
  value: T;
  warnings: string[];
}

export interface ValidationFail {
  ok: false;
  warnings: string[];
  issues: string[];
}

export type ValidationResult<T> = ValidationOk<T> | ValidationFail;

/**
 * Parse `raw` (JSON string) and run it through `schema`. Never throws.
 * Returns `ValidationFail` with a list of human-readable issues if either
 * the JSON parse or the zod parse fails.
 */
export function validateOrNull<T extends z.ZodTypeAny>(
  raw: string,
  schema: T,
): ValidationResult<z.infer<T>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, warnings: [], issues: [`json_parse_failed: ${msg}`] };
  }
  const safe = schema.safeParse(parsed);
  if (!safe.success) {
    return {
      ok: false,
      warnings: [],
      issues: safe.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    };
  }
  return { ok: true, value: safe.data, warnings: [] };
}

/**
 * Drop any id from `ids` that is NOT in `allow`. Returns the filtered list
 * plus a warning if any were dropped. Mirrors the model in
 * `scripts/review-cluster.mjs:546-551` (the project's own gold standard
 * for handling LLM-emitted external identifiers).
 *
 * `fieldName` is purely for log messages so the warning is actionable.
 */
export function assertIdsInAllowlist(
  ids: readonly string[],
  allow: ReadonlySet<string>,
  fieldName: string,
): { kept: string[]; dropped: string[]; warnings: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const id of ids) {
    if (allow.has(id)) kept.push(id);
    else dropped.push(id);
  }
  const warnings =
    dropped.length === 0
      ? []
      : [
          `${fieldName}: dropped ${dropped.length} id(s) not in input allowlist (likely hallucinated): ${dropped
            .slice(0, 5)
            .join(', ')}${dropped.length > 5 ? '…' : ''}`,
        ];
  return { kept, dropped, warnings };
}

// Tokens we treat as "claims that must be grounded in context":
//   - ISO-ish dates (YYYY-MM-DD)
//   - dollar / yuan / euro amounts ($1, $99.99, ¥1000, €5)
//   - percent literals (12%, 0.5%)
//   - double-quoted strings of length >= 4
//
// The set is deliberately conservative — false positives here cause
// noisy warnings, not request failures, so we keep it tight.
const LITERAL_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'iso_date', re: /\b(\d{4})-(\d{2})-(\d{2})\b/g },
  { name: 'money', re: /[$¥€£]\s?\d+(?:[.,]\d+)?/g },
  { name: 'percent', re: /\b\d+(?:\.\d+)?%/g },
  { name: 'quoted', re: /"([^"\n]{4,80})"/g },
];

function extractLiterals(text: string): { kind: string; value: string }[] {
  const out: { kind: string; value: string }[] = [];
  for (const { name, re } of LITERAL_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.push({ kind: name, value: m[0] });
    }
  }
  return out;
}

/**
 * For each literal token (dates, money, percents, quoted strings) that
 * appears in any of the `fields` of `value`, verify it also appears
 * verbatim somewhere in `context`. Returns the list of ungrounded
 * literals (suspicious — likely hallucinated).
 *
 * Deliberately a soft signal: callers add the result to a structured log
 * row / metadata field instead of dropping the payload, because false
 * positives are easy (e.g. the model paraphrased an ungrounded date) and
 * the alternative (block all such outputs) hurts UX. Industry guidance
 * (AgentGuard hallucination_proxy) treats this as a heuristic, not a
 * gate.
 */
export function assertLiteralsInContext(
  value: Record<string, unknown>,
  context: string,
  fields: readonly string[],
): { ungrounded: { field: string; kind: string; value: string }[]; warnings: string[] } {
  const ungrounded: { field: string; kind: string; value: string }[] = [];
  for (const field of fields) {
    const raw = value[field];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const literals = extractLiterals(raw);
    for (const lit of literals) {
      if (!context.includes(lit.value)) {
        ungrounded.push({ field, kind: lit.kind, value: lit.value });
      }
    }
  }
  const warnings =
    ungrounded.length === 0
      ? []
      : [
          `literal_grounding: ${ungrounded.length} literal(s) not found in input context (possibly hallucinated)`,
        ];
  return { ungrounded, warnings };
}

/**
 * Post-processor for free-text AI output meant to be a list. Splits on
 * newlines, strips bullet / number prefixes, drops empty lines, and
 * caps at `maxItems` so a runaway model can't produce thousands of
 * entries. Used by ai-field/route.ts after R-185 (we didn't switch it to
 * tool_use because each call returns a single textual field).
 */
export function normalizeAiList(text: string, maxItems = 20): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, maxItems);
}

/**
 * Defensive cap for free-text fields (goal, scope). Keeps the first
 * `maxChars` characters and appends an ellipsis only when truncated.
 */
export function normalizeAiText(text: string, maxChars = 2000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1)}…`;
}

/**
 * Convenience wrapper that callers can use to log validation warnings
 * in a consistent shape — surfaced in pino under one tag so dashboards
 * can grep for them.
 */
export function logValidationWarnings(
  purpose: string,
  warnings: readonly string[],
  context?: Record<string, unknown>,
): void {
  if (warnings.length === 0) return;
  logger.warn({ purpose, warnings, ...context }, 'ai_validation_warnings');
}
