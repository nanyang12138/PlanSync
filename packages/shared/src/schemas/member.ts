import { z } from 'zod';

export const memberRoleSchema = z.enum(['owner', 'developer']);
export const memberTypeSchema = z.enum(['human', 'agent']);

export const createMemberSchema = z.object({
  name: z.string().min(1).max(100),
  role: memberRoleSchema,
  type: memberTypeSchema.default('human'),
});

export const updateMemberSchema = z.object({
  role: memberRoleSchema.optional(),
  type: memberTypeSchema.optional(),
});

export const memberSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  role: memberRoleSchema,
  type: memberTypeSchema,
  createdAt: z.coerce.date(),
});
