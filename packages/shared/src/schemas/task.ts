import { z } from 'zod';

export const TASK_TYPES = [
  'code',
  'research',
  'design',
  'bug',
  'refactor',
  'test',
  'docs',
] as const;
export const TASK_PRIORITIES = [
  { value: 'p0', label: 'P0 — Critical' },
  { value: 'p1', label: 'P1 — Normal' },
  { value: 'p2', label: 'P2 — Low' },
] as const;

export const taskTypeSchema = z.enum(TASK_TYPES);
export const taskPrioritySchema = z.enum(['p0', 'p1', 'p2']);
// R-192: `awaiting_evidence` is the new terminal-pending status assigned
// when an agent completes a run but the system cannot yet derive `done`
// from git + verification rule signals (PR not merged, no commit linked
// to a bound deliverable, drift unresolved). See `task-state-machine.ts`.
export const taskStatusSchema = z.enum([
  'todo',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
  'awaiting_evidence',
]);
export const assigneeTypeSchema = z.enum(['human', 'agent', 'unassigned']);

const dateRangeRefinement = {
  check: (d: { startDate?: Date | null; dueDate?: Date | null }) =>
    !d.startDate || !d.dueDate || d.startDate <= d.dueDate,
  message: 'startDate must be on or before dueDate',
  path: ['dueDate'] as const,
};

// R-027/R-028: shapes are exported separately so MCP tools (which need a
// ZodRawShape, not a ZodEffects wrapping ZodObject) can import them directly
// and stay in sync with the API contract automatically.
export const createTaskShape = {
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  type: taskTypeSchema,
  priority: taskPrioritySchema.default('p1'),
  assignee: z.string().optional(),
  assigneeType: assigneeTypeSchema.default('unassigned'),
  branchName: z.string().optional(),
  agentContext: z.string().optional(),
  expectedOutput: z.string().optional(),
  agentConstraints: z.array(z.string()).default([]),
  planDeliverableRefs: z.array(z.string()).default([]),
  // Drift v2: which plan constraint / standard items this task depends on.
  // Empty = "depends on all" (conservative). Narrow these to reduce false
  // 'breaking' classifications for unrelated plan edits.
  planConstraintRefs: z.array(z.string()).default([]),
  planStandardRefs: z.array(z.string()).default([]),
  startDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
} as const;

export const createTaskSchema = z.object(createTaskShape).refine(dateRangeRefinement.check, {
  message: dateRangeRefinement.message,
  path: [...dateRangeRefinement.path],
});

export const updateTaskShape = {
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  type: taskTypeSchema.optional(),
  priority: taskPrioritySchema.optional(),
  status: taskStatusSchema.optional(),
  assignee: z.string().nullable().optional(),
  assigneeType: assigneeTypeSchema.optional(),
  branchName: z.string().nullable().optional(),
  prUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'PR URL must use http(s)')
    .nullable()
    .optional(),
  agentContext: z.string().nullable().optional(),
  expectedOutput: z.string().nullable().optional(),
  agentConstraints: z.array(z.string()).optional(),
  planDeliverableRefs: z.array(z.string()).optional(),
  planConstraintRefs: z.array(z.string()).optional(),
  planStandardRefs: z.array(z.string()).optional(),
  startDate: z.coerce.date().nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
} as const;

export const updateTaskSchema = z.object(updateTaskShape).refine(dateRangeRefinement.check, {
  message: dateRangeRefinement.message,
  path: [...dateRangeRefinement.path],
});

export const claimTaskSchema = z.object({
  assigneeType: assigneeTypeSchema.default('agent'),
  startImmediately: z.boolean().default(true),
});

export const declineTaskSchema = z.object({});

export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  type: taskTypeSchema,
  priority: taskPrioritySchema,
  status: taskStatusSchema,
  assignee: z.string().nullable(),
  assigneeType: assigneeTypeSchema,
  boundPlanVersion: z.number().int(),
  branchName: z.string().nullable(),
  prUrl: z.string().nullable(),
  agentContext: z.string().nullable(),
  expectedOutput: z.string().nullable(),
  agentConstraints: z.array(z.string()),
  planDeliverableRefs: z.array(z.string()),
  planConstraintRefs: z.array(z.string()),
  planStandardRefs: z.array(z.string()),
  startDate: z.coerce.date().nullable(),
  dueDate: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const executionRunStatusSchema = z.enum([
  'running',
  // R-002: a run becomes 'paused' the moment a new plan activates and the
  // engine identifies it as bound to a version that the new plan supersedes.
  // 'paused' is non-terminal — endedAt stays null — until either the agent
  // ack-pauses with a progress note (→ superseded) or the pause-ack timeout
  // scanner sweeps it (→ superseded with reason='pause_timeout'). The run
  // route hard-rejects heartbeat and complete in this state.
  'paused',
  'completed',
  'failed',
  'cancelled',
  'stale',
  'superseded',
]);

export const createExecutionRunSchema = z.object({
  taskId: z.string().optional(),
  executorType: z.enum(['human', 'agent']),
  executorName: z.string(),
  // #2941: the git branch this run will work on, recorded at start time.
  // Optional for backwards compatibility, but when supplied it becomes the
  // run's immutable ownership anchor: the `require_pr_merged` gate binds the
  // merged PR's head branch to this value so a mutable `task.prUrl` cannot be
  // repointed at a parallel run's / teammate's PR at complete time.
  branchName: z.string().optional(),
});

export const completeExecutionRunSchema = z.object({
  status: z.enum(['completed', 'failed']),
  outputSummary: z.string().optional(),
  filesChanged: z.array(z.string()).default([]),
  branchName: z.string().optional(),
  blockers: z.array(z.string()).default([]),
  driftSignals: z.array(z.string()).default([]),
  deliverablesMet: z.array(z.string()).default([]),
});

export const executionRunSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  executorType: z.enum(['human', 'agent']),
  executorName: z.string(),
  boundPlanVersion: z.number().int(),
  status: executionRunStatusSchema,
  taskPackSnapshot: z.record(z.unknown()),
  lastHeartbeatAt: z.coerce.date().nullable(),
  outputSummary: z.string().nullable(),
  filesChanged: z.array(z.string()),
  branchName: z.string().nullable(),
  blockers: z.array(z.string()),
  driftSignals: z.array(z.string()),
  deliverablesMet: z.array(z.string()),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().nullable(),
});
