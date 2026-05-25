import { z } from 'zod';

// R-155: structured CRUD schemas for `PlanDeliverable` rows. The
// `plansync_deliverable_*` MCP tools and the new
// `/plans/[planId]/deliverables/...` REST routes share these definitions so
// the wire shape, the MCP tool surface, and the API validation layer cannot
// drift apart (R-034 schema-drift CI test catches divergence).
//
// `refType` and `status` are intentionally kept as string enums (not Prisma
// enums) so a future ref kind (e.g. `figma_file`, `confluence_page`) can be
// added with a one-migration string CHECK constraint change and a one-line
// edit here, without an enum-rename migration that would break Prisma type
// generation across all packages.

export const deliverableRefTypeSchema = z.enum([
  'file_glob',
  'api_spec',
  'figma_frame',
  'notion_page',
  'free',
]);

export const deliverableStatusSchema = z.enum(['draft', 'active', 'done', 'deprecated']);

// Slug shape mirrors the convention used by `slugify()` in
// `packages/api/src/lib/plan-items.ts`: lowercase, alphanumeric + dashes,
// optionally namespaced with `/`. A 120-char cap is loose enough for
// readable namespaces (e.g. `auth/oidc/callback-handler`) but small
// enough that the unique B-tree index stays compact.
export const deliverableSlugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9\-/]*$/, {
    message: 'slug must be lowercase alphanumeric with - and / (no leading - or /)',
  });

export const deliverableSchema = z.object({
  id: z.string(),
  planId: z.string(),
  slug: deliverableSlugSchema,
  title: z.string(),
  body: z.string(),
  refType: deliverableRefTypeSchema.nullable(),
  refUri: z.string().nullable(),
  status: deliverableStatusSchema,
  // `supersededById` is the new (current) row that replaced this one when a
  // newer plan version was activated. Null on the row that is still
  // current. Walking the chain `supersededBy → supersededBy → …` ends at
  // the latest version's row.
  supersededById: z.string().nullable(),
  createdAt: z.coerce.date(),
});

// POST body for creating a deliverable on a `draft` plan. `slug` is
// caller-provided so the human-readable identifier survives plan rewrites
// and renames — letting the server auto-generate it would defeat the
// stability guarantee the entire R-150 design relies on. `body` is
// optional and defaults to the title at the route layer (consistent with
// how the dual-write helper populates rows from legacy String[] items).
export const createDeliverableSchema = z.object({
  slug: deliverableSlugSchema,
  title: z.string().min(1).max(500),
  body: z.string().max(20000).optional(),
  refType: deliverableRefTypeSchema.optional(),
  refUri: z.string().max(2000).optional(),
  status: deliverableStatusSchema.optional(),
});

// PATCH body. Every field is optional; an empty body is a 400 at the
// route layer (the route enforces `Object.keys(body).length > 0`). Slug
// is intentionally NOT updatable here — slugs are stable identifiers and
// renaming them would silently break drift attribution. To "rename" a
// deliverable, supersede the old one with a new row carrying the new slug.
export const updateDeliverableSchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    body: z.string().max(20000).optional(),
    refType: deliverableRefTypeSchema.nullable().optional(),
    refUri: z.string().max(2000).nullable().optional(),
    status: deliverableStatusSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'at least one field must be provided',
  });

// POST body for supersede. `newDeliverableId` must belong to the SAME
// plan (active version is the common case) and must not already be
// pointed at by another supersede chain. Both checks are enforced server-
// side; the schema only validates shape.
export const supersedeDeliverableSchema = z.object({
  newDeliverableId: z.string().min(1),
});
