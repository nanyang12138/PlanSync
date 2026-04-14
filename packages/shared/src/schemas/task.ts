import { z } from 'zod';

export const taskTypeSchema = z.enum(['code', 'research', 'design', 'bug', 'refactor']);
export const taskPrioritySchema = z.enum(['p0', 'p1', 'p2']);
export const taskStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']);
export const assigneeTypeSchema = z.enum(['human', 'agent', 'unassigned']);

export const createTaskSchema = z.object({
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
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  type: taskTypeSchema.optional(),
  priority: taskPrioritySchema.optional(),
  status: taskStatusSchema.optional(),
  assignee: z.string().nullable().optional(),
  assigneeType: assigneeTypeSchema.optional(),
  branchName: z.string().nullable().optional(),
  prUrl: z.string().url().nullable().optional(),
  agentContext: z.string().nullable().optional(),
  expectedOutput: z.string().nullable().optional(),
  agentConstraints: z.array(z.string()).optional(),
  planDeliverableRefs: z.array(z.string()).optional(),
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
