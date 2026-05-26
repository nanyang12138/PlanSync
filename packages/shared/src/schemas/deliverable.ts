import { z } from 'zod';

// R-155: shared zod schemas for the per-deliverable CRUD surface introduced
// alongside the `plansync_deliverable_*` MCP tools. These power both the
// REST routes under `/api/projects/:projectId/plans/:planId/deliverables/...`
// and the MCP tool argument shapes, so a schema mismatch between client and
// server is a build failure.
//
// Why "shared" instead of inlining: R-150 carries the design contract that
// `refType`, `refUri`, and `status` are CHECK-constrained at the DB layer.
// Codifying the same enums here keeps the three layers (DB CHECK, Zod input
// validation, MCP tool description) in lockstep so any future refType
// addition is a single-PR change rather than a hunt across the repo.

// refType ∈ ('file_glob' | 'api_spec' | 'figma_frame' | 'notion_page' | 'free').
// Matches the CHECK constraint in `20260523080000_add_plan_items_split` /
// the R-150 schema commentary; kept in sync with PlanDeliverable.refType.
export const deliverableRefTypeSchema = z.enum([
  'file_glob',
  'api_spec',
  'figma_frame',
  'notion_page',
  'free',
]);

// status ∈ ('draft' | 'active' | 'done' | 'deprecated'). Independent of
// Plan.status — a deliverable can be 'done' while the surrounding plan is
// still 'active', and the UI/CLI treat that as the per-item lifecycle.
export const deliverableStatusSchema = z.enum(['draft', 'active', 'done', 'deprecated']);

// Slug constraint mirrors the `slugify(...)` helper in `plan-items.ts` plus
// allowance for slashes (e.g. `auth/oidc-callback`) so owners can hand-write
// readable slugs. Length cap matches the soft-cap used by writeBoth (50)
// with a small headroom for hand-written slugs that need extra qualifiers.
export const deliverableSlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9/_-]*$/, {
    message: 'slug must be lowercase alphanumerics with `/`, `-`, `_` separators',
  });

export const createDeliverableSchema = z.object({
  slug: deliverableSlugSchema,
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  refType: deliverableRefTypeSchema.optional(),
  refUri: z.string().min(1).max(2000).nullable().optional(),
  status: deliverableStatusSchema.optional(),
});

// PATCH input. All fields optional; refType/refUri/status can be cleared by
// passing null. Slug is intentionally excluded — slug is a stable identifier
// once a deliverable lives on a plan version (renaming would silently break
// the supersede chain that R-152 links via slug). Use supersede + create on
// the new plan version to "rename" instead.
export const updateDeliverableSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1).optional(),
    refType: deliverableRefTypeSchema.nullable().optional(),
    refUri: z.string().max(2000).nullable().optional(),
    status: deliverableStatusSchema.optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'patch body must contain at least one field',
  });

// Body for POST .../deliverables/:deliverableId/supersede. Empty by default
// (the supersede operation only needs the row id from the URL); reserved
// here so a future `supersededById` override can be added without a route
// signature change.
export const supersedeDeliverableSchema = z.object({});

export const deliverableSchema = z.object({
  id: z.string(),
  planId: z.string(),
  slug: z.string(),
  title: z.string(),
  body: z.string(),
  refType: deliverableRefTypeSchema.nullable(),
  refUri: z.string().nullable(),
  status: deliverableStatusSchema,
  supersededById: z.string().nullable(),
  createdAt: z.coerce.date(),
});
