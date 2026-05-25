import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createDeliverableSchema,
  deliverableRefTypeSchema,
  deliverableStatusSchema,
} from '@plansync/shared';
import { z } from 'zod';
import { ApiClient } from '../api-client';

// R-155: `plansync_deliverable_*` MCP tool family. Five tools mirror the
// new REST surface under `/api/projects/:projectId/plans/:planId/
// deliverables/...`:
//
//   list       — GET     /deliverables                (any project member)
//   show       — GET     /deliverables/:id            (any project member)
//   create     — POST    /deliverables                (owner only, draft plan)
//   update     — PATCH   /deliverables/:id            (owner only, draft plan)
//   supersede  — POST    /deliverables/:id/supersede  (owner only)
//
// Schemas are imported from `@plansync/shared` so the MCP argument shape
// and the API zod schema cannot drift (the contract test in
// `mcp-server/tests/schema-drift.test.ts` enforces this for the existing
// tool surface; the Zod inputs we pass below pick the same fields by
// re-using the shared schema's individual zod nodes).

export function registerDeliverableTools(server: McpServer, api: ApiClient) {
  // -- list ---------------------------------------------------------------
  server.tool(
    'plansync_deliverable_list',
    'List PlanDeliverable rows attached to a plan version. Read-only; any project member can call. ' +
      'Returns the full row shape (id, slug, title, body, refType, refUri, status, supersededById, createdAt) ' +
      'so callers can drive UI cards, drift attribution, or the new GitHub Action semantic gate without a follow-up fetch.',
    {
      projectId: z.string(),
      planId: z
        .string()
        .describe('Plan ID (use plansync_plan_list / plansync_plan_active to find).'),
    },
    async (args) => {
      const result = await api.get(
        `/api/projects/${args.projectId}/plans/${args.planId}/deliverables`,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // -- show ---------------------------------------------------------------
  server.tool(
    'plansync_deliverable_show',
    'Get a single PlanDeliverable by row id. Read-only; any project member can call. ' +
      'Returns NOT_FOUND when the row does not belong to the supplied (projectId, planId), so a row id leaked ' +
      'across projects cannot be probed.',
    {
      projectId: z.string(),
      planId: z.string(),
      deliverableId: z
        .string()
        .describe('PlanDeliverable row id (NOT slug; the slug is human-friendly).'),
    },
    async (args) => {
      const result = await api.get(
        `/api/projects/${args.projectId}/plans/${args.planId}/deliverables/${args.deliverableId}`,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // -- create -------------------------------------------------------------
  //
  // OWNER ONLY. Plan must be in `draft`. The legacy `plan.deliverables`
  // String[] mirror is re-derived inside the API route's transaction so
  // plan_show keeps observing a consistent view.
  server.tool(
    'plansync_deliverable_create',
    'Add a new PlanDeliverable to a draft plan. OWNER ONLY. Plan must be in "draft" status — propose a new ' +
      'plan version first if the plan is already active. The (planId, slug) pair is unique, so a duplicate slug ' +
      'returns STATE_CONFLICT. Do NOT call this when doing "work as <agent>" delegation — use plansync_plan_suggest ' +
      'with `deliverableId` instead.',
    {
      projectId: z.string(),
      planId: z.string(),
      slug: createDeliverableSchema.shape.slug.describe(
        'Stable, human-readable slug — must be unique within the plan, lowercase alphanumerics + `/`, `-`, `_`. ' +
          'Examples: "auth/oidc-callback", "infra/db-pool".',
      ),
      title: createDeliverableSchema.shape.title,
      body: createDeliverableSchema.shape.body,
      refType: deliverableRefTypeSchema
        .optional()
        .describe(
          'How the deliverable points at concrete artifacts. Defaults to "free" (free-text description, no link).',
        ),
      refUri: z
        .string()
        .min(1)
        .max(2000)
        .nullable()
        .optional()
        .describe(
          'URI matching `refType`: glob pattern for "file_glob", URL for "api_spec" / "figma_frame" / ' +
            '"notion_page", null/omitted for "free".',
        ),
      status: deliverableStatusSchema
        .optional()
        .describe(
          'Per-item lifecycle, independent of plan.status. Defaults to "active" so newly-added items show up ' +
            'in the active set immediately.',
        ),
      asAgent: z.string().optional(),
    },
    async (args) => {
      const { projectId, planId, asAgent, ...body } = args;
      const effectiveApi = asAgent ? api.withUser(asAgent) : api;
      const result = await effectiveApi.post(
        `/api/projects/${projectId}/plans/${planId}/deliverables`,
        body,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // -- update -------------------------------------------------------------
  //
  // OWNER ONLY. Plan must be in `draft`. Slug is intentionally not
  // updatable — the supersede chain matches by slug, so renaming it would
  // silently break the link to the previous plan version. To "rename" a
  // slug, propose a new plan version with the renamed deliverable and let
  // the activate-time supersedeDeliverables() (R-152) wire it up.
  server.tool(
    'plansync_deliverable_update',
    'Patch a PlanDeliverable row. OWNER ONLY. Plan must be in "draft". Pass any subset of {title, body, ' +
      'refType, refUri, status}; pass null on refType/refUri to clear. Slug is immutable here — to rename, ' +
      'create a new deliverable with the new slug on the next plan version (the activate-time supersede ' +
      'helper will wire the chain).',
    {
      projectId: z.string(),
      planId: z.string(),
      deliverableId: z.string(),
      title: z.string().min(1).max(200).optional(),
      body: z.string().min(1).optional(),
      refType: deliverableRefTypeSchema.nullable().optional(),
      refUri: z.string().max(2000).nullable().optional(),
      status: deliverableStatusSchema.optional(),
      asAgent: z.string().optional(),
    },
    async (args) => {
      const { projectId, planId, deliverableId, asAgent, ...body } = args;
      const effectiveApi = asAgent ? api.withUser(asAgent) : api;
      const result = await effectiveApi.patch(
        `/api/projects/${projectId}/plans/${planId}/deliverables/${deliverableId}`,
        body,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // -- supersede ----------------------------------------------------------
  //
  // OWNER ONLY. Manual counterpart to the activate-time
  // supersedeDeliverables() helper — set status='deprecated' on the row,
  // optionally point at a successor row id. The successor must live in
  // the same project (validated server-side); it does NOT have to live on
  // the same plan version, which is the whole point of the supersede
  // chain (carrying identity across version bumps).
  server.tool(
    'plansync_deliverable_supersede',
    'Mark a PlanDeliverable as deprecated and (optionally) link it to a successor row. OWNER ONLY. ' +
      'Use to retire a single deliverable mid-iteration without bumping a whole plan version. ' +
      'Successor must belong to the same project; passing the same row id self-links and is rejected.',
    {
      projectId: z.string(),
      planId: z.string(),
      deliverableId: z.string(),
      supersededById: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Optional successor row id. When omitted the row is just marked deprecated with no forward link.',
        ),
      asAgent: z.string().optional(),
    },
    async (args) => {
      const { projectId, planId, deliverableId, asAgent, supersededById } = args;
      const effectiveApi = asAgent ? api.withUser(asAgent) : api;
      const result = await effectiveApi.post(
        `/api/projects/${projectId}/plans/${planId}/deliverables/${deliverableId}/supersede`,
        supersededById ? { supersededById } : {},
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
