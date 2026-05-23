import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiClient } from '../api-client';
import { McpConfig } from '../config';
import { getDelegationAgent } from './status';

export function registerPlanTools(server: McpServer, api: ApiClient, config: McpConfig) {
  server.tool(
    'plansync_plan_list',
    'List all plans for a project',
    { projectId: z.string(), page: z.number().optional(), pageSize: z.number().optional() },
    async (args) => {
      const params = new URLSearchParams();
      if (args.page) params.set('page', String(args.page));
      if (args.pageSize) params.set('pageSize', String(args.pageSize));
      const qs = params.toString();
      const result = await api.get(`/api/projects/${args.projectId}/plans${qs ? `?${qs}` : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_show',
    'Get plan details by ID. Note: if you have a version number, use plansync_plan_list to find the planId first.',
    { projectId: z.string(), planId: z.string().describe('Plan ID (not version number)') },
    async (args) => {
      const result = await api.get(`/api/projects/${args.projectId}/plans/${args.planId}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_active',
    'Get the currently active plan for a project',
    { projectId: z.string() },
    async (args) => {
      const result = await api.get(`/api/projects/${args.projectId}/plans/active`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_create',
    'Create a new plan draft. OWNER ONLY. Do NOT call this when doing "work as <agent>" delegation — use plansync_plan_suggest instead.',
    {
      projectId: z.string(),
      title: z.string(),
      goal: z.string(),
      scope: z.string(),
      constraints: z.array(z.string()).optional(),
      standards: z.array(z.string()).optional(),
      deliverables: z.array(z.string()).optional(),
      openQuestions: z.array(z.string()).optional(),
      requiredReviewers: z.array(z.string()).optional(),
      asAgent: z
        .string()
        .optional()
        .describe(
          "Delegation: act as this agent so the API enforces their role, not the session user's.",
        ),
    },
    async (args) => {
      const { projectId, asAgent, ...body } = args;
      const effectiveApi = asAgent ? api.withUser(asAgent) : api;

      // Guard against duplicate draft/proposed plans is enforced server-side
      // in the API (POST /api/projects/:projectId/plans) so callers using curl
      // or other HTTP clients cannot bypass it. See R-036.
      const result = await effectiveApi.post(`/api/projects/${projectId}/plans`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_update',
    'Update a draft plan. OWNER ONLY. Do NOT call this when doing "work as <agent>" delegation.',
    {
      projectId: z.string(),
      planId: z.string(),
      title: z.string().optional(),
      goal: z.string().optional(),
      scope: z.string().optional(),
      constraints: z.array(z.string()).optional(),
      standards: z.array(z.string()).optional(),
      deliverables: z.array(z.string()).optional(),
      openQuestions: z.array(z.string()).optional(),
      requiredReviewers: z.array(z.string()).optional(),
      changeSummary: z.string().optional(),
      why: z.string().optional(),
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
      const result = await effectiveApi.patch(`/api/projects/${projectId}/plans/${planId}`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_propose',
    'Submit a draft plan for review. OWNER ONLY. Do NOT call this when doing "work as <agent>" delegation.',
    {
      projectId: z.string(),
      planId: z.string().describe('Plan ID of the draft to propose'),
      reviewers: z
        .array(
          z.union([
            z.string(),
            z.object({
              name: z.string(),
              focusNotes: z
                .string()
                .optional()
                .describe(
                  'What this reviewer should focus on (e.g. "backend feasibility", "security constraints")',
                ),
              type: z
                .enum(['human', 'agent'])
                .optional()
                .describe('Member type for auto-added reviewers. Defaults to human.'),
            }),
          ]),
        )
        .optional()
        .describe(
          'Reviewer names or {name, focusNotes} objects. Use focusNotes to tell each reviewer what aspect to focus on.',
        ),
      asAgent: z
        .string()
        .optional()
        .describe(
          "Delegation: act as this agent so the API enforces their role, not the session user's.",
        ),
    },
    async (args) => {
      const { projectId, planId, reviewers, asAgent } = args;
      const effectiveApi = asAgent ? api.withUser(asAgent) : api;
      const result = await effectiveApi.post(`/api/projects/${projectId}/plans/${planId}/propose`, {
        reviewers,
      });
      const verify = await effectiveApi.get<{ data?: { status?: string } }>(
        `/api/projects/${projectId}/plans/${planId}`,
      );
      const verifiedStatus = verify.data?.status ?? 'unknown';
      if (verifiedStatus !== 'proposed') {
        return {
          content: [
            {
              type: 'text',
              text:
                `Propose call succeeded but plan status is still "${verifiedStatus}", not "proposed". ` +
                `Tell the user the proposal may have failed and suggest checking /status.`,
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_activate',
    'Activate a plan, superseding the current active plan and triggering drift scan. OWNER ONLY. Do NOT call this when doing "work as <agent>" delegation.',
    {
      projectId: z.string(),
      planId: z.string().describe('Plan ID (not version). Use plansync_plan_list to find it.'),
      asAgent: z
        .string()
        .optional()
        .describe(
          "Delegation: act as this agent so the API enforces their role, not the session user's.",
        ),
    },
    async (args) => {
      const effectiveApi = args.asAgent ? api.withUser(args.asAgent) : api;
      const result = await effectiveApi.post(
        `/api/projects/${args.projectId}/plans/${args.planId}/activate`,
        {},
      );
      const verify = await effectiveApi.get<{ data?: { status?: string } }>(
        `/api/projects/${args.projectId}/plans/${args.planId}`,
      );
      const verifiedStatus = verify.data?.status ?? 'unknown';
      if (verifiedStatus !== 'active') {
        return {
          content: [
            {
              type: 'text',
              text:
                `Activation call succeeded but plan status is still "${verifiedStatus}", not "active". ` +
                `Tell the user the activation may have failed and suggest checking /status.`,
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_reactivate',
    'Reactivate a superseded plan (rollback). OWNER ONLY. Do NOT call this when doing "work as <agent>" delegation.',
    {
      projectId: z.string(),
      planId: z.string().describe('Plan ID of the superseded plan to reactivate'),
      asAgent: z
        .string()
        .optional()
        .describe(
          "Delegation: act as this agent so the API enforces their role, not the session user's.",
        ),
    },
    async (args) => {
      const effectiveApi = args.asAgent ? api.withUser(args.asAgent) : api;
      const result = await effectiveApi.post(
        `/api/projects/${args.projectId}/plans/${args.planId}/reactivate`,
        {},
      );
      const verify = await effectiveApi.get<{ data?: { status?: string } }>(
        `/api/projects/${args.projectId}/plans/${args.planId}`,
      );
      const verifiedStatus = verify.data?.status ?? 'unknown';
      if (verifiedStatus !== 'active') {
        return {
          content: [
            {
              type: 'text',
              text:
                `Reactivation call succeeded but plan status is still "${verifiedStatus}", not "active". ` +
                `Tell the user the rollback may have failed and suggest checking /status.`,
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_review_approve',
    'Approve a plan review. Automatically finds your review by your username — no need to look up reviewId. Use asUser to approve on behalf of an agent member (delegation).',
    {
      projectId: z.string(),
      planId: z.string(),
      comment: z.string().optional(),
      asUser: z
        .string()
        .optional()
        .describe(
          'Approve on behalf of this user instead of the current session user (agent delegation)',
        ),
    },
    async (args) => {
      const targetUser = args.asUser ?? getDelegationAgent() ?? config.userName;
      const reviews = await api.get<{ data: Array<{ id: string; reviewerName: string }> }>(
        `/api/projects/${args.projectId}/plans/${args.planId}/reviews`,
      );
      const myReview = reviews.data.find((r) => r.reviewerName === targetUser);
      if (!myReview) {
        throw new Error(`No pending review found for user "${targetUser}" on this plan`);
      }
      const result = await api.post(
        `/api/projects/${args.projectId}/plans/${args.planId}/reviews/${myReview.id}?action=approve`,
        { comment: args.comment },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_review_reject',
    'Reject a plan review. Automatically finds your review by your username — no need to look up reviewId. Use asUser to reject on behalf of an agent member (delegation). A non-empty comment explaining the rejection is required.',
    {
      projectId: z.string(),
      planId: z.string(),
      comment: z
        .string()
        .min(1, 'comment is required when rejecting a plan review')
        .describe('Required: reason for rejection (non-empty)'),
      asUser: z
        .string()
        .optional()
        .describe(
          'Reject on behalf of this user instead of the current session user (agent delegation)',
        ),
    },
    async (args) => {
      const targetUser = args.asUser ?? getDelegationAgent() ?? config.userName;
      const reviews = await api.get<{ data: Array<{ id: string; reviewerName: string }> }>(
        `/api/projects/${args.projectId}/plans/${args.planId}/reviews`,
      );
      const myReview = reviews.data.find((r) => r.reviewerName === targetUser);
      if (!myReview) {
        throw new Error(`No pending review found for user "${targetUser}" on this plan`);
      }
      const result = await api.post(
        `/api/projects/${args.projectId}/plans/${args.planId}/reviews/${myReview.id}?action=reject`,
        { comment: args.comment },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'plansync_plan_diff',
    'Get AI-generated diff between this plan version and the previous one. Returns changes[], summary, and breakingChanges flag. ' +
      'Call this when reviewing a proposed plan to understand what changed before deciding to approve or reject.',
    {
      projectId: z.string(),
      planId: z.string().describe('Plan ID of the proposed plan to diff against its predecessor'),
    },
    async (args) => {
      const result = await api.get(`/api/projects/${args.projectId}/plans/${args.planId}/diff`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // R-175 step 1 of 3 — collapse the four plansync_plan_*_append tools into a
  // single plansync_plan_patch with a discriminated `op` field. The new tool is
  // the canonical surface going forward; the four old tool names stay registered
  // as deprecated aliases for one release so live agent prompts (CLAUDE.md /
  // AGENTS.md / cli ai-loop) can be updated without an atomic flag day.
  //
  // The aliases forward to the same internal `applyPatches` helper so duplicate-
  // skip semantics, the 50-items-per-op guard, and `asAgent` delegation routing
  // are guaranteed to behave identically across the new and old surface.
  //
  // Future ops (e.g. `{op:'remove', field, items}`, `{op:'set', field, value}`)
  // can be added without breaking the schema — they just join the discriminated
  // union under the same tool name.

  const APPENDABLE_FIELDS = ['deliverables', 'constraints', 'standards', 'openQuestions'] as const;
  type AppendableField = (typeof APPENDABLE_FIELDS)[number];

  // Single-op input shape, exported via this closure so the alias schemas
  // below stay byte-identical to the corresponding patch entry.
  const appendOpSchema = z.object({
    op: z.literal('append'),
    field: z.enum(APPENDABLE_FIELDS).describe('Which array field on the draft plan to append to.'),
    items: z
      .array(z.string().min(1).max(2000))
      .min(1)
      .max(50)
      .describe(`Items to append (max 50 per op). Call again for more.`),
  });

  /**
   * Apply a list of patches in order against the same draft plan. Each patch
   * becomes one POST to the existing collapsed `/append` API endpoint (the
   * server already accepts `{field, items}`), so this is purely an MCP-side
   * fan-out — no API changes.
   *
   * If any individual patch fails the API call is allowed to throw; the
   * wrapper layer turns it into a uniform error envelope (R-037), and prior
   * patches in the batch that already succeeded stay committed. The agent
   * gets enough information from the error to retry just the failed op.
   */
  async function applyPatches(
    projectId: string,
    planId: string,
    patches: Array<z.infer<typeof appendOpSchema>>,
    asAgent: string | undefined,
  ): Promise<Array<unknown>> {
    const effectiveApi = asAgent ? api.withUser(asAgent) : api;
    const results: Array<unknown> = [];
    for (const patch of patches) {
      const result = await effectiveApi.post(`/api/projects/${projectId}/plans/${planId}/append`, {
        field: patch.field,
        items: patch.items,
      });
      results.push(result);
    }
    return results;
  }

  server.tool(
    'plansync_plan_patch',
    `Apply one or more patches to a draft plan in a single call. OWNER ONLY. ` +
      `Replaces plansync_plan_{deliverables,constraints,standards,open_questions}_append ` +
      `— the four old tool names still work as deprecated aliases for this release. ` +
      `Each patch has shape {op:'append', field, items}; supply up to 20 patches and the ` +
      `server applies them in order with the same dup-skip semantics as the legacy tools ` +
      `(items that already exist on the field, after trim, are silently dropped). ` +
      `Use this instead of plansync_plan_update for large array edits — each patch ` +
      `stays small so the LLM response doesn't hit max_tokens. ` +
      `Do NOT call this in "work as <agent>" delegation mode — use plansync_plan_suggest instead.`,
    {
      projectId: z.string(),
      planId: z.string(),
      patches: z
        .array(appendOpSchema)
        .min(1)
        .max(20)
        .describe(
          'Ordered list of patches. Each patch targets one field; mixing fields in a single ' +
            'call is supported. Up to 20 patches per call; each capped at 50 items.',
        ),
      asAgent: z.string().optional(),
    },
    async (args) => {
      const { projectId, planId, patches, asAgent } = args;
      const results = await applyPatches(projectId, planId, patches, asAgent);
      // Return one entry per applied patch in input order so agents can
      // diff against their patch list to learn which items were dropped
      // as duplicates.
      const payload = results.length === 1 ? results[0] : { applied: results.length, results };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  );

  // ---- Deprecated aliases (kept for one release per R-175 fix_steps #5) ----
  //
  // Each old name forwards into `applyPatches` with a single-op patches array.
  // Tool description includes a [DEPRECATED] tag so any future MCP client that
  // surfaces tool descriptions to its user (Claude Desktop, Cursor agent
  // inspector, etc.) shows the migration path. Schema is unchanged so existing
  // callers don't break.
  const makeDeprecatedAppendAlias = (name: string, field: AppendableField, label: string) =>
    server.tool(
      name,
      `[DEPRECATED — use plansync_plan_patch] Append items to a draft plan's ${field} array ` +
        `(max 50 per call). OWNER ONLY. Behaviour identical to ` +
        `plansync_plan_patch({patches:[{op:'append', field:'${field}', items}]}); will be ` +
        `removed in the next release. Idempotent: duplicate ${label} items skipped.`,
      {
        projectId: z.string(),
        planId: z.string(),
        items: z
          .array(z.string().min(1).max(2000))
          .min(1)
          .max(50)
          .describe(`Items to append (max 50 per call). Call again for more.`),
        asAgent: z.string().optional(),
      },
      async (args) => {
        const { projectId, planId, items, asAgent } = args;
        const results = await applyPatches(
          projectId,
          planId,
          [{ op: 'append', field, items }],
          asAgent,
        );
        return { content: [{ type: 'text', text: JSON.stringify(results[0], null, 2) }] };
      },
    );

  makeDeprecatedAppendAlias('plansync_plan_deliverables_append', 'deliverables', 'deliverable');
  makeDeprecatedAppendAlias('plansync_plan_constraints_append', 'constraints', 'constraint');
  makeDeprecatedAppendAlias('plansync_plan_standards_append', 'standards', 'standard');
  makeDeprecatedAppendAlias(
    'plansync_plan_open_questions_append',
    'openQuestions',
    'open question',
  );
}
