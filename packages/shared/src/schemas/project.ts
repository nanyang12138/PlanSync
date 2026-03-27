import { z } from 'zod';

export const projectPhaseSchema = z.enum(['planning', 'active', 'completed']);

export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  phase: projectPhaseSchema.default('planning'),
  repoUrl: z.string().url().optional(),
  defaultBranch: z.string().optional(),
});

export const updateProjectSchema = createProjectSchema.partial();

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  phase: projectPhaseSchema,
  repoUrl: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
