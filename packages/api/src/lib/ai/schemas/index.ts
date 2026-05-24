// R-185: tool_use schema registry for AI strict structured output.
//
// Each entry pairs a zod schema (runtime validation in our Node process)
// with a JSON Schema (sent to Anthropic / AMD via tools[].input_schema so
// the decoder is constrained at the token level and can't emit a payload
// that violates the shape).
//
// Why hand-written JSON Schema instead of zod-to-json-schema?
//   1. No new dep — the four schemas here are small and stable.
//   2. Strict-mode requires Anthropic-flavoured constraints (no $ref, no
//      union-with-discriminator) that zod-to-json-schema generators don't
//      always emit cleanly.
//   3. The JSON Schema is THE thing the model sees — we want full visual
//      control of the field descriptions because they're effectively
//      prompt text in disguise.
//
// All five entries follow the same pattern:
//
//   export const FOO_TOOL = {
//     name: 'emit_foo',       // verb-noun; what the model "calls"
//     description: '...',     // short prompt-side hint
//     jsonSchema: { ... },    // sent to provider as tools[].input_schema
//     zod: z.object({ ... }), // runtime parse on our side
//   } as const satisfies AiToolSchema<...>;
//
// R-186 will hang the validate/grounding layer off the zod result; R-187
// will plug a second-pass verifier in between the model output and the
// caller. Keep this file dependency-free so both layers can import freely.

import { z } from 'zod';

export interface AiToolSchema<TZod extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly zod: TZod;
}

// ---------------------------------------------------------------------------
// completion-verify  (R-185 entry for runs/[runId] route)
// ---------------------------------------------------------------------------

export const completionVerifyResultZ = z.object({
  verified: z.boolean(),
  score: z.number().min(0).max(100),
  breakdown: z
    .object({
      specificity: z.number(),
      coherence: z.number(),
      coverage: z.number(),
    })
    .optional(),
  gaps: z.array(z.string()),
  feedback: z.string(),
});

export type CompletionVerifyResult = z.infer<typeof completionVerifyResultZ>;

export const COMPLETION_VERIFY_TOOL = {
  name: 'emit_completion_verification',
  description:
    'Emit the completion verification verdict for an execution run. ALWAYS call this tool exactly once.',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['verified', 'score', 'gaps', 'feedback'],
    properties: {
      verified: {
        type: 'boolean',
        description: 'true only if score >= 75',
      },
      score: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'Overall score across the three dimensions',
      },
      breakdown: {
        type: 'object',
        additionalProperties: false,
        required: ['specificity', 'coherence', 'coverage'],
        properties: {
          specificity: { type: 'integer', minimum: 0, maximum: 35 },
          coherence: { type: 'integer', minimum: 0, maximum: 35 },
          coverage: { type: 'integer', minimum: 0, maximum: 30 },
        },
      },
      gaps: {
        type: 'array',
        items: { type: 'string' },
        description: 'List each unmet requirement with explanation. Empty array means no gaps.',
      },
      feedback: {
        type: 'string',
        description: 'One specific sentence telling the agent what to add or improve.',
      },
    },
  },
  zod: completionVerifyResultZ,
} as const satisfies AiToolSchema<typeof completionVerifyResultZ>;

// ---------------------------------------------------------------------------
// impact-analysis  (drift impact per task)
// ---------------------------------------------------------------------------

export const impactAnalysisResultZ = z.object({
  compatibilityScore: z.number().min(0).max(100),
  compatible: z.boolean(),
  suggestedAction: z.enum(['no_impact', 'rebind', 'cancel']),
  reasoning: z.string(),
  affectedAreas: z.array(z.string()),
  riskLevel: z.enum(['high', 'medium', 'low']),
});

export type ImpactAnalysisResult = z.infer<typeof impactAnalysisResultZ>;

export const IMPACT_ANALYSIS_TOOL = {
  name: 'emit_impact_analysis',
  description: 'Emit the drift impact analysis verdict for a single task. Call exactly once.',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'compatibilityScore',
      'compatible',
      'suggestedAction',
      'reasoning',
      'affectedAreas',
      'riskLevel',
    ],
    properties: {
      compatibilityScore: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: '0-100; >70 = compatible, 30-70 = adjust, <30 = incompatible',
      },
      compatible: { type: 'boolean' },
      suggestedAction: {
        type: 'string',
        enum: ['no_impact', 'rebind', 'cancel'],
      },
      reasoning: {
        type: 'string',
        description: 'Brief explanation grounded in the diff content.',
      },
      affectedAreas: { type: 'array', items: { type: 'string' } },
      riskLevel: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
  },
  zod: impactAnalysisResultZ,
} as const satisfies AiToolSchema<typeof impactAnalysisResultZ>;

// ---------------------------------------------------------------------------
// conflict-prediction  (cross-task conflicts)
// ---------------------------------------------------------------------------

export const conflictPredictionResultZ = z.object({
  conflicts: z.array(
    z.object({
      taskIds: z.array(z.string()).min(2),
      type: z.enum(['resource', 'dependency', 'scope_overlap']),
      severity: z.enum(['high', 'medium', 'low']),
      description: z.string().min(1),
      recommendation: z.string().min(1),
    }),
  ),
});

export type ConflictPredictionResult = z.infer<typeof conflictPredictionResultZ>;

export const CONFLICT_PREDICTION_TOOL = {
  name: 'emit_conflict_prediction',
  description:
    'Emit predicted cross-task conflicts. Each conflict MUST reference at least two task ids from the input list.',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['conflicts'],
    properties: {
      conflicts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['taskIds', 'type', 'severity', 'description', 'recommendation'],
          properties: {
            taskIds: {
              type: 'array',
              minItems: 2,
              items: { type: 'string', minLength: 1 },
            },
            type: { type: 'string', enum: ['resource', 'dependency', 'scope_overlap'] },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            description: { type: 'string', minLength: 1 },
            recommendation: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  },
  zod: conflictPredictionResultZ,
} as const satisfies AiToolSchema<typeof conflictPredictionResultZ>;

// ---------------------------------------------------------------------------
// plan-diff  (semantic plan version comparison)
// ---------------------------------------------------------------------------

export const planDiffResultZ = z.object({
  changes: z.array(
    z.object({
      aspect: z.enum([
        'goal',
        'scope',
        'constraints',
        'standards',
        'deliverables',
        'openQuestions',
      ]),
      type: z.enum(['added', 'removed', 'modified']),
      from: z.string().nullable(),
      to: z.string().nullable(),
      impact: z.enum(['high', 'medium', 'low']),
      description: z.string(),
      affectedAreas: z.array(z.string()),
    }),
  ),
  summary: z.string(),
  breakingChanges: z.boolean(),
});

export type PlanDiffResult = z.infer<typeof planDiffResultZ>;

export const PLAN_DIFF_TOOL = {
  name: 'emit_plan_diff',
  description: 'Emit the semantic diff between two plan versions. Call exactly once.',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['changes', 'summary', 'breakingChanges'],
    properties: {
      changes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['aspect', 'type', 'from', 'to', 'impact', 'description', 'affectedAreas'],
          properties: {
            aspect: {
              type: 'string',
              enum: ['goal', 'scope', 'constraints', 'standards', 'deliverables', 'openQuestions'],
            },
            type: { type: 'string', enum: ['added', 'removed', 'modified'] },
            from: { type: ['string', 'null'] },
            to: { type: ['string', 'null'] },
            impact: { type: 'string', enum: ['high', 'medium', 'low'] },
            description: { type: 'string' },
            affectedAreas: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      summary: { type: 'string' },
      breakingChanges: { type: 'boolean' },
    },
  },
  zod: planDiffResultZ,
} as const satisfies AiToolSchema<typeof planDiffResultZ>;

// ---------------------------------------------------------------------------
// ai-draft  (full plan draft from title + optional context)
// ---------------------------------------------------------------------------

export const planDraftResultZ = z.object({
  goal: z.string().min(1),
  scope: z.string().min(1),
  constraints: z.array(z.string()),
  standards: z.array(z.string()),
  deliverables: z.array(z.string()),
  openQuestions: z.array(z.string()),
});

export type PlanDraftResult = z.infer<typeof planDraftResultZ>;

export const PLAN_DRAFT_TOOL = {
  name: 'emit_plan_draft',
  description:
    'Emit a complete plan draft. Each array should contain 3-6 specific, actionable items.',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['goal', 'scope', 'constraints', 'standards', 'deliverables', 'openQuestions'],
    properties: {
      goal: { type: 'string', minLength: 1, description: '2-4 sentences' },
      scope: { type: 'string', minLength: 1, description: '2-4 sentences' },
      constraints: { type: 'array', items: { type: 'string' } },
      standards: { type: 'array', items: { type: 'string' } },
      deliverables: { type: 'array', items: { type: 'string' } },
      openQuestions: { type: 'array', items: { type: 'string' } },
    },
  },
  zod: planDraftResultZ,
} as const satisfies AiToolSchema<typeof planDraftResultZ>;
