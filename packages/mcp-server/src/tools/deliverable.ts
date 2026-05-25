/**
 * R-155: `plansync_deliverable_*` MCP tools.
 *
 * Five tools matching the REST surface in
 * `packages/api/src/app/api/projects/[projectId]/plans/[planId]/deliverables/`.
 *
 *   plansync_deliverable_list      — any member (filterable by status / refType)
 *   plansync_deliverable_show      — any member
 *   plansync_deliverable_create    — OWNER only, draft plans only
 *   plansync_deliverable_update    — OWNER only, draft plans only
 *   plansync_deliverable_supersede — OWNER only (cross-version retire)
 *
 * Owner-only writes go through `asAgent`-aware routing (same pattern as
 * `plansync_plan_update`) so a "work as <agent>" delegation that
 * accidentally calls these will get a clean `FORBIDDEN` from the API
 * layer, not a silent agent-as-owner mutation.
 *
 * The MCP schemas re-import the canonical zod schemas from
 * `@plansync/shared` so the wire shape, the API validation, and the MCP
 * tool surface cannot drift apart. The schema-drift CI test (R-034)
 * watches for divergence the next time someone changes the body fields.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  deliverableRefTypeSchema,
  deliverableStatusSchema,
  deliverableSlugSchema,
} from '@plansync/shared';
import { ApiClient } from '../api-client';

export function registerDeliverableTools(server: McpServer, api: ApiClient) {
  server.tool(
    'plansync_deliverable_list',
    'List deliverables (PlanDeliverable rows) on a plan. Read-only; any project member. ' +
      'Filter by status (draft/active/done/deprecated) or refType (file_glob/api_spec/...) — the ' +
      'GitHub Action drift-gate (R-157) uses {status:"active", refType:"file_glob"} to fetch the ' +
      'active glob set in one call. Returns the rows in stable insertion order so the response ' +
      'is suitable for diffs and rendering.',
    {
      projectId: z.string(),
      planId: z.string(),
      status: deliverableStatusSchema.optional(),
      refType: deliverableRefTypeSchema.optional(),
    },
    async (args) => {
      const qs = new URLSearchParams();
      if (args.status) qs.set('status', args.status);
      if (args.refType) qs.set('refType', args.refType);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const result = await api.get(
        `/api/projects/${args.projectId}/plans/${args.planId}/deliverables${suffix}`,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_deliverable_show',
    'Show one deliverable by id. Read-only; any project member.',
    {
      projectId: z.string(),
      planId: z.string(),
      deliverableId: z.string(),
    },
    async (args) => {
      const result = await api.get(
        `/api/projects/${args.projectId}/plans/${args.planId}/deliverables/${args.deliverableId}`,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_deliverable_create',
    'Create a new deliverable on a DRAFT plan. OWNER ONLY. Do NOT call this when doing ' +
      '"work as <agent>" delegation — use plansync_plan_suggest with deliverableId instead. ' +
      'Slug must be unique within the plan and stable across plan versions; do not include ' +
      'leading slashes or uppercase. Use refType=file_glob + refUri="src/**/*.ts" to make the ' +
      'deliverable participate in R-157 drift-gate; use refType=free (default) for narrative items.',
    {
      projectId: z.string(),
      planId: z.string(),
      slug: deliverableSlugSchema,
      title: z.string().min(1).max(500),
      body: z.string().max(20000).optional(),
      refType: deliverableRefTypeSchema.optional(),
      refUri: z.string().max(2000).optional(),
      status: deliverableStatusSchema.optional(),
      asAgent: z
        .string()
        .optional()
        .describe(
          "Delegation: act as this agent so the API enforces their role, not the session user's.",
        ),
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

  server.tool(
    'plansync_deliverable_update',
    'Update a deliverable on a DRAFT plan. OWNER ONLY. ' +
      'Slug is NOT updatable — to change the human-readable identifier, create a new deliverable ' +
      'on the next plan version and use plansync_deliverable_supersede to link it.',
    {
      projectId: z.string(),
      planId: z.string(),
      deliverableId: z.string(),
      title: z.string().min(1).max(500).optional(),
      body: z.string().max(20000).optional(),
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

  server.tool(
    'plansync_deliverable_supersede',
    'Mark one deliverable as superseded by another. OWNER ONLY. The "new" deliverable must be on ' +
      'the same or a newer plan version. Sets supersededById on the old row and flips its status ' +
      'to deprecated. Use this for explicit retire flows that the activate-time auto-supersede ' +
      'cannot infer (e.g. slug renames across plan versions, mid-version cancellation).',
    {
      projectId: z.string(),
      planId: z
        .string()
        .describe('Plan that owns the OLD (being-retired) deliverable.'),
      deliverableId: z
        .string()
        .describe('Old (being-retired) deliverable id.'),
      newDeliverableId: z
        .string()
        .describe('New deliverable id that replaces it (must be in the same project).'),
      asAgent: z.string().optional(),
    },
    async (args) => {
      const { projectId, planId, deliverableId, newDeliverableId, asAgent } = args;
      const effectiveApi = asAgent ? api.withUser(asAgent) : api;
      const result = await effectiveApi.post(
        `/api/projects/${projectId}/plans/${planId}/deliverables/${deliverableId}/supersede`,
        { newDeliverableId },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
