// Mock AI responses for the `mock` provider (R-124).
//
// When PLANSYNC_AI_MOCK=1 is set, the AiClient short-circuits network calls
// and returns canned JSON responses from this module. This lets CI exercise
// the AI code paths (plan diff, impact analysis, conflict prediction,
// completion verification, chat) without holding real API keys.
//
// The dispatcher matches on the *system prompt* string because callers always
// pair a specific system prompt with a single AI capability. Add a new branch
// here when adding a new AI feature.

export interface MockPlanDiff {
  changes: Array<{
    aspect: string;
    type: string;
    from: string | null;
    to: string | null;
    impact: string;
    description: string;
    affectedAreas: string[];
  }>;
  summary: string;
  breakingChanges: boolean;
}

const PLAN_DIFF_MOCK: MockPlanDiff = {
  changes: [
    {
      aspect: 'goal',
      type: 'modified',
      from: 'original goal',
      to: 'updated goal',
      impact: 'medium',
      description: 'Mock: plan goal was rephrased',
      affectedAreas: ['api'],
    },
  ],
  summary: 'Mock plan diff produced by PLANSYNC_AI_MOCK=1.',
  breakingChanges: false,
};

const IMPACT_MOCK = {
  compatibilityScore: 85,
  compatible: true,
  suggestedAction: 'no_impact' as const,
  reasoning: 'Mock: change does not affect this task.',
  affectedAreas: [],
  riskLevel: 'low',
};

const CONFLICT_MOCK = { conflicts: [] };

const COMPLETION_VERIFY_MOCK = {
  verified: true,
  score: 85,
  breakdown: { specificity: 30, coherence: 30, coverage: 25 },
  gaps: [],
  feedback: 'Mock: evidence accepted by PLANSYNC_AI_MOCK.',
};

const CHAT_MOCK = 'Mock chat reply from PLANSYNC_AI_MOCK=1.';

const PLAN_AI_DRAFT_MOCK = {
  goal: 'Mock: implement the requested feature end-to-end (PLANSYNC_AI_MOCK=1).',
  scope: 'Mock: in-scope is the feature implementation; out-of-scope is unrelated refactoring.',
  constraints: ['Mock: must not break existing tests', 'Mock: follow project code style'],
  standards: ['Mock: add unit tests for new logic', 'Mock: keep functions under 50 lines'],
  deliverables: ['Mock: working implementation', 'Mock: passing CI'],
  openQuestions: ['Mock: are there performance requirements?'],
};

// System-prompt substrings that identify each capability. These are
// intentionally short and stable so editing the prompt body does not
// break the dispatcher.
//
// R-188 note: we previously matched with `startsWith()` because the
// capability sentence was the first line of every system prompt. After
// R-188 prepended UNTRUSTED_INPUT_PREAMBLE to every system prompt, the
// capability sentence is no longer the first line; we now match with
// `includes()` to stay robust against any future prepended preamble.
//
// planAiDraft must be checked before chat — both prompts contain 'You are
// PlanSync AI', but planAiDraft's signature is more specific and must win.
const PROMPT_SIGNATURES = {
  planDiff: 'You are an expert project analyst.',
  impact: 'You are an expert at analyzing how plan changes',
  conflict: 'You are an expert at predicting conflicts',
  completionVerify: 'You are a task completion verifier',
  planAiDraft: 'Generate a structured software project plan draft',
  chat: 'You are PlanSync AI',
} as const;

export function getMockAiResponse(system: string): string {
  if (system.includes(PROMPT_SIGNATURES.planDiff)) {
    return JSON.stringify(PLAN_DIFF_MOCK);
  }
  if (system.includes(PROMPT_SIGNATURES.impact)) {
    return JSON.stringify(IMPACT_MOCK);
  }
  if (system.includes(PROMPT_SIGNATURES.conflict)) {
    return JSON.stringify(CONFLICT_MOCK);
  }
  if (system.includes(PROMPT_SIGNATURES.completionVerify)) {
    return JSON.stringify(COMPLETION_VERIFY_MOCK);
  }
  if (system.includes(PROMPT_SIGNATURES.planAiDraft)) {
    return JSON.stringify(PLAN_AI_DRAFT_MOCK);
  }
  if (system.includes(PROMPT_SIGNATURES.chat)) {
    return CHAT_MOCK;
  }
  // Unknown capability — return an empty JSON object. Callers that JSON.parse
  // will succeed and either treat it as "no result" or fail validation,
  // matching the behaviour of an under-specified real model output.
  return '{}';
}
