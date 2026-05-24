// R-190a: prompt versioning + golden-set regression tests.
//
// Two responsibilities:
//
//   1. Each `<purpose>_PROMPT_VERSION` constant must follow the agreed
//      naming convention (`<purpose>@YYYY-MM-DD-r<n>`). This lets the
//      R-182 ai_calls dashboard segment metrics by prompt revision and
//      makes prompt rollouts auditable.
//
//   2. The body of each system prompt must NOT silently drift away from
//      what the version claims. We pin a SHA-256 of the canonical
//      system-prompt body to each version string in the table below;
//      changing the prompt text without bumping `r<n>` fails CI with a
//      clear "please bump version" message.
//
// How to update: when you intentionally change a system prompt body,
//   * bump the trailing `r<n>` in the prompt module
//   * run this test, copy the new hash from the failure message into
//     EXPECTED_PROMPT_HASHES
//   * commit both together so reviewers see the contract update
//
// This is a much cheaper version of a full golden-set regression: it
// catches accidental prompt edits without requiring offline LLM calls.

import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';

import { CHAT_PROMPT_VERSION, CHAT_SYSTEM } from '../../src/lib/ai/prompts/chat.prompt';
import {
  COMPLETION_VERIFY_PROMPT_VERSION,
  COMPLETION_VERIFY_SYSTEM,
} from '../../src/lib/ai/prompts/completion-verify.prompt';
import {
  CONFLICT_PREDICTION_PROMPT_VERSION,
  CONFLICT_PREDICTION_SYSTEM,
} from '../../src/lib/ai/prompts/conflict-prediction.prompt';
import {
  IMPACT_ANALYSIS_PROMPT_VERSION,
  IMPACT_ANALYSIS_SYSTEM,
} from '../../src/lib/ai/prompts/impact-analysis.prompt';
import {
  PLAN_DIFF_PROMPT_VERSION,
  PLAN_DIFF_SYSTEM,
} from '../../src/lib/ai/prompts/plan-diff.prompt';
// R-187 verifier prompts were added under R-190a too so they get the
// same body-drift guard as the generator prompts.
import {
  IMPACT_CANCEL_VERIFIER_PROMPT_VERSION,
  PLAN_DIFF_VERIFIER_PROMPT_VERSION,
} from '../../src/lib/ai/verifier';

const VERSION_PATTERN = /^[a-z][a-z0-9_-]*@\d{4}-\d{2}-\d{2}-r\d+$/;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// EXPECTED_PROMPT_HASHES — these are LITERAL STRINGS pinned at PR-review
// time, NOT recomputed from the current source. If you change a prompt
// body without bumping its version constant, the runtime sha256 below
// will diverge from the pinned literal and the test fails — that's the
// whole point.
//
// Failure-mode reminder (issue #832): an earlier version of this test
// wrote `[CHAT_PROMPT_VERSION]: sha256(CHAT_SYSTEM)` which made the
// expected and actual hashes identical by construction — the test could
// never catch undeclared prompt edits. Do NOT compute these values at
// test runtime.
//
// How to update: when you intentionally bump `<purpose>_PROMPT_VERSION`
// AND change the body, run the test, copy the new actual hash from the
// failure message into the literal below, commit both together.
const EXPECTED_PROMPT_HASHES: Record<string, string> = {
  'chat@2026-05-24-r1':
    'f0f6c45945233b5029df88f487ebb3574b5c343cf4bedf1dd34563e58074ae88',
  'completion-verify@2026-05-24-r1':
    '32cdc24637f591e474f7f14d1ff5d6e2241748f0a4c86942ef3c5b20d2d55bb8',
  'conflict-prediction@2026-05-24-r1':
    '6098ce8116d926aeea74f0562f38757ecb4bd794eb9ce06acd4aa9feaface2d7',
  'impact-analysis@2026-05-24-r1':
    'acc0086693d76b1917519615ce52ed7cabe38da94537af918f12997160bfc9d0',
  'plan-diff@2026-05-24-r1':
    '1dcd21f88fad60e7fcb695725475d7b84977350d2fc25e6f59592bdac994ce8b',
};

describe('R-190a prompt version naming convention', () => {
  it.each([
    ['chat', CHAT_PROMPT_VERSION],
    ['completion-verify', COMPLETION_VERIFY_PROMPT_VERSION],
    ['conflict-prediction', CONFLICT_PREDICTION_PROMPT_VERSION],
    ['impact-analysis', IMPACT_ANALYSIS_PROMPT_VERSION],
    ['plan-diff', PLAN_DIFF_PROMPT_VERSION],
    ['plan-diff verifier', PLAN_DIFF_VERIFIER_PROMPT_VERSION],
    ['impact-cancel verifier', IMPACT_CANCEL_VERIFIER_PROMPT_VERSION],
  ])('%s prompt version matches `<purpose>@YYYY-MM-DD-r<n>`', (_label, version) => {
    expect(version).toMatch(VERSION_PATTERN);
  });

  it('all versions are unique across purposes', () => {
    const versions = [
      CHAT_PROMPT_VERSION,
      COMPLETION_VERIFY_PROMPT_VERSION,
      CONFLICT_PREDICTION_PROMPT_VERSION,
      IMPACT_ANALYSIS_PROMPT_VERSION,
      PLAN_DIFF_PROMPT_VERSION,
      PLAN_DIFF_VERIFIER_PROMPT_VERSION,
      IMPACT_CANCEL_VERIFIER_PROMPT_VERSION,
    ];
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('each version starts with its own purpose slug', () => {
    expect(CHAT_PROMPT_VERSION.startsWith('chat@')).toBe(true);
    expect(COMPLETION_VERIFY_PROMPT_VERSION.startsWith('completion-verify@')).toBe(true);
    expect(CONFLICT_PREDICTION_PROMPT_VERSION.startsWith('conflict-prediction@')).toBe(true);
    expect(IMPACT_ANALYSIS_PROMPT_VERSION.startsWith('impact-analysis@')).toBe(true);
    expect(PLAN_DIFF_PROMPT_VERSION.startsWith('plan-diff@')).toBe(true);
    expect(PLAN_DIFF_VERIFIER_PROMPT_VERSION.startsWith('verifier-plan-diff@')).toBe(true);
    expect(IMPACT_CANCEL_VERIFIER_PROMPT_VERSION.startsWith('verifier-impact-cancel@')).toBe(true);
  });
});

describe('R-190a EXPECTED_PROMPT_HASHES table completeness', () => {
  // Catches "developer added a new *_PROMPT_VERSION constant but forgot
  // to register a pinned hash" — without this meta-check the body-drift
  // test below would silently skip the new entry.
  it.each([
    CHAT_PROMPT_VERSION,
    COMPLETION_VERIFY_PROMPT_VERSION,
    CONFLICT_PREDICTION_PROMPT_VERSION,
    IMPACT_ANALYSIS_PROMPT_VERSION,
    PLAN_DIFF_PROMPT_VERSION,
  ])('%s has a pinned hash entry', (version) => {
    expect(EXPECTED_PROMPT_HASHES).toHaveProperty(version);
    expect(typeof EXPECTED_PROMPT_HASHES[version]).toBe('string');
    expect(EXPECTED_PROMPT_HASHES[version]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('R-190a prompt body hash matches declared version (drift guard)', () => {
  const ROWS: Array<[string, string, string]> = [
    ['chat', CHAT_PROMPT_VERSION, CHAT_SYSTEM],
    ['completion-verify', COMPLETION_VERIFY_PROMPT_VERSION, COMPLETION_VERIFY_SYSTEM],
    [
      'conflict-prediction',
      CONFLICT_PREDICTION_PROMPT_VERSION,
      CONFLICT_PREDICTION_SYSTEM,
    ],
    ['impact-analysis', IMPACT_ANALYSIS_PROMPT_VERSION, IMPACT_ANALYSIS_SYSTEM],
    ['plan-diff', PLAN_DIFF_PROMPT_VERSION, PLAN_DIFF_SYSTEM],
  ];

  it.each(ROWS)(
    '%s body hash matches version %s',
    (label, version, body) => {
      const actualHash = sha256(body);
      const expectedHash = EXPECTED_PROMPT_HASHES[version];
      if (actualHash !== expectedHash) {
        // Self-explanatory failure message: tells the developer exactly
        // what to do next.
        throw new Error(
          [
            `Prompt body for "${label}" changed without bumping its version.`,
            `  current version : ${version}`,
            `  current hash    : ${actualHash}`,
            `  expected hash   : ${expectedHash}`,
            'Either:',
            `  (a) revert the body change, or`,
            `  (b) bump the trailing r<n> in ${label}.prompt.ts AND update`,
            `      EXPECTED_PROMPT_HASHES in r190a-prompt-versioning.test.ts to ${actualHash}`,
          ].join('\n'),
        );
      }
      expect(actualHash).toBe(expectedHash);
    },
  );
});
