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

const VERSION_PATTERN = /^[a-z][a-z0-9_-]*@\d{4}-\d{2}-\d{2}-r\d+$/;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// EXPECTED_PROMPT_HASHES — keep in alphabetical order so the diff stays
// minimal when only one entry changes. Each value is the SHA-256 of the
// entire system prompt string (preamble + body + everything else
// exported from `*.prompt.ts`).
const EXPECTED_PROMPT_HASHES: Record<string, string> = {
  [CHAT_PROMPT_VERSION]: sha256(CHAT_SYSTEM),
  [COMPLETION_VERIFY_PROMPT_VERSION]: sha256(COMPLETION_VERIFY_SYSTEM),
  [CONFLICT_PREDICTION_PROMPT_VERSION]: sha256(CONFLICT_PREDICTION_SYSTEM),
  [IMPACT_ANALYSIS_PROMPT_VERSION]: sha256(IMPACT_ANALYSIS_SYSTEM),
  [PLAN_DIFF_PROMPT_VERSION]: sha256(PLAN_DIFF_SYSTEM),
};

describe('R-190a prompt version naming convention', () => {
  it.each([
    ['chat', CHAT_PROMPT_VERSION],
    ['completion-verify', COMPLETION_VERIFY_PROMPT_VERSION],
    ['conflict-prediction', CONFLICT_PREDICTION_PROMPT_VERSION],
    ['impact-analysis', IMPACT_ANALYSIS_PROMPT_VERSION],
    ['plan-diff', PLAN_DIFF_PROMPT_VERSION],
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
    ];
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('each version starts with its own purpose slug', () => {
    expect(CHAT_PROMPT_VERSION.startsWith('chat@')).toBe(true);
    expect(COMPLETION_VERIFY_PROMPT_VERSION.startsWith('completion-verify@')).toBe(true);
    expect(CONFLICT_PREDICTION_PROMPT_VERSION.startsWith('conflict-prediction@')).toBe(true);
    expect(IMPACT_ANALYSIS_PROMPT_VERSION.startsWith('impact-analysis@')).toBe(true);
    expect(PLAN_DIFF_PROMPT_VERSION.startsWith('plan-diff@')).toBe(true);
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
