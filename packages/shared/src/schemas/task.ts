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
export const taskStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']);
export const assigneeTypeSchema = z.enum(['human', 'agent', 'unassigned']);

const dateRangeRefinement = {
  check: (d: { startDate?: Date | null; dueDate?: Date | null }) =>
    !d.startDate || !d.dueDate || d.startDate <= d.dueDate,
  message: 'startDate must be on or before dueDate',
  path: ['dueDate'] as const,
};

export const createTaskSchema = z
  .object({
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
    startDate: z.coerce.date().optional(),
    dueDate: z.coerce.date().optional(),
  })
  .refine(dateRangeRefinement.check, {
    message: dateRangeRefinement.message,
    path: [...dateRangeRefinement.path],
  });

export const updateTaskSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
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
    startDate: z.coerce.date().nullable().optional(),
    dueDate: z.coerce.date().nullable().optional(),
  })
  .refine(dateRangeRefinement.check, {
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
  startDate: z.coerce.date().nullable(),
  dueDate: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const executionRunStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
  'stale',
]);

export const createExecutionRunSchema = z.object({
  taskId: z.string().optional(),
  executorType: z.enum(['human', 'agent']),
  executorName: z.string(),
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
