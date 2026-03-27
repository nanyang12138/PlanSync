import { z } from 'zod';
import { paginationSchema, activitySchema, createActivitySchema } from '../schemas/common';
import {
  projectSchema,
  createProjectSchema,
  updateProjectSchema,
  projectPhaseSchema,
} from '../schemas/project';
import {
  memberSchema,
  createMemberSchema,
  updateMemberSchema,
  memberRoleSchema,
  memberTypeSchema,
} from '../schemas/member';
import {
  planSchema,
  createPlanSchema,
  updatePlanSchema,
  planStatusSchema,
  planReviewSchema,
  reviewActionSchema,
  reviewStatusSchema,
} from '../schemas/plan';
import {
  suggestionSchema,
  createSuggestionSchema,
  resolveSuggestionSchema,
  suggestionFieldSchema,
  suggestionActionSchema,
  suggestionStatusSchema,
} from '../schemas/suggestion';
import {
  commentSchema,
  createCommentSchema,
  updateCommentSchema,
} from '../schemas/comment';
import {
  taskSchema,
  createTaskSchema,
  updateTaskSchema,
  claimTaskSchema,
  taskTypeSchema,
  taskPrioritySchema,
  taskStatusSchema,
  assigneeTypeSchema,
  executionRunSchema,
  createExecutionRunSchema,
  completeExecutionRunSchema,
  executionRunStatusSchema,
} from '../schemas/task';
import {
  driftAlertSchema,
  resolveDriftSchema,
  driftTypeSchema,
  driftSeveritySchema,
  driftStatusSchema,
  driftResolveActionSchema,
} from '../schemas/drift';

// Common
export type Pagination = z.infer<typeof paginationSchema>;
export type Activity = z.infer<typeof activitySchema>;
export type CreateActivity = z.infer<typeof createActivitySchema>;

// Project
export type Project = z.infer<typeof projectSchema>;
export type CreateProject = z.infer<typeof createProjectSchema>;
export type UpdateProject = z.infer<typeof updateProjectSchema>;
export type ProjectPhase = z.infer<typeof projectPhaseSchema>;

// Member
export type ProjectMember = z.infer<typeof memberSchema>;
export type CreateMember = z.infer<typeof createMemberSchema>;
export type UpdateMember = z.infer<typeof updateMemberSchema>;
export type MemberRole = z.infer<typeof memberRoleSchema>;
export type MemberType = z.infer<typeof memberTypeSchema>;

// Plan
export type Plan = z.infer<typeof planSchema>;
export type CreatePlan = z.infer<typeof createPlanSchema>;
export type UpdatePlan = z.infer<typeof updatePlanSchema>;
export type PlanStatus = z.infer<typeof planStatusSchema>;
export type PlanReview = z.infer<typeof planReviewSchema>;
export type ReviewAction = z.infer<typeof reviewActionSchema>;
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

// Suggestion
export type PlanSuggestion = z.infer<typeof suggestionSchema>;
export type CreateSuggestion = z.infer<typeof createSuggestionSchema>;
export type ResolveSuggestion = z.infer<typeof resolveSuggestionSchema>;
export type SuggestionField = z.infer<typeof suggestionFieldSchema>;
export type SuggestionAction = z.infer<typeof suggestionActionSchema>;
export type SuggestionStatus = z.infer<typeof suggestionStatusSchema>;

// Comment
export type PlanComment = z.infer<typeof commentSchema>;
export type CreateComment = z.infer<typeof createCommentSchema>;
export type UpdateComment = z.infer<typeof updateCommentSchema>;

// Task
export type Task = z.infer<typeof taskSchema>;
export type CreateTask = z.infer<typeof createTaskSchema>;
export type UpdateTask = z.infer<typeof updateTaskSchema>;
export type ClaimTask = z.infer<typeof claimTaskSchema>;
export type TaskType = z.infer<typeof taskTypeSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type AssigneeType = z.infer<typeof assigneeTypeSchema>;

// ExecutionRun
export type ExecutionRun = z.infer<typeof executionRunSchema>;
export type CreateExecutionRun = z.infer<typeof createExecutionRunSchema>;
export type CompleteExecutionRun = z.infer<typeof completeExecutionRunSchema>;
export type ExecutionRunStatus = z.infer<typeof executionRunStatusSchema>;

// DriftAlert
export type DriftAlert = z.infer<typeof driftAlertSchema>;
export type ResolveDrift = z.infer<typeof resolveDriftSchema>;
export type DriftType = z.infer<typeof driftTypeSchema>;
export type DriftSeverity = z.infer<typeof driftSeveritySchema>;
export type DriftStatus = z.infer<typeof driftStatusSchema>;
export type DriftResolveAction = z.infer<typeof driftResolveActionSchema>;

// Paginated response wrapper
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}
