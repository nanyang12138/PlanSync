import { z } from 'zod';

export const planStatusSchema = z.enum(['draft', 'proposed', 'active', 'superseded']);
export const reviewStatusSchema = z.enum(['pending', 'approved', 'rejected']);

export const createPlanSchema = z.object({
  title: z.string().min(1).max(200),
  goal: z.string().min(1),
  scope: z.string().min(1),
  constraints: z.array(z.string()).default([]),
  standards: z.array(z.string()).default([]),
  deliverables: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  changeSummary: z.string().optional(),
  why: z.string().optional(),
  requiredReviewers: z.array(z.string()).default([]),
});

export const updatePlanSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  goal: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  constraints: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  deliverables: z.array(z.string()).optional(),
  openQuestions: z.array(z.string()).optional(),
  changeSummary: z.string().optional(),
  why: z.string().optional(),
  requiredReviewers: z.array(z.string()).optional(),
});

export const planSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  version: z.number().int(),
  status: planStatusSchema,
  title: z.string(),
  goal: z.string(),
  scope: z.string(),
  constraints: z.array(z.string()),
  standards: z.array(z.string()),
  deliverables: z.array(z.string()),
  openQuestions: z.array(z.string()),
  changeSummary: z.string().nullable(),
  why: z.string().nullable(),
  requiredReviewers: z.array(z.string()),
  createdBy: z.string(),
  activatedAt: z.coerce.date().nullable(),
  activatedBy: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const planReviewSchema = z.object({
  id: z.string(),
  planId: z.string(),
  reviewerName: z.string(),
  status: reviewStatusSchema,
  comment: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const reviewActionSchema = z.object({
  comment: z.string().optional(),
});

// Reviewer spec accepted by POST /api/projects/:projectId/plans/:planId/propose.
// Accepts either a bare username (string) or a structured object with optional
// focusNotes / type. Used to bootstrap PlanReview rows + auto-add reviewers
// as project members when proposing a plan for review.
export const reviewerSpecSchema = z.union([
  z.string().min(1).max(120),
  z.object({
    name: z.string().min(1).max(120),
    focusNotes: z.string().max(2000).optional(),
    type: z.enum(['human', 'agent']).optional(),
  }),
]);

export const proposePlanSchema = z.object({
  reviewers: z.array(reviewerSpecSchema).max(20).optional(),
});
