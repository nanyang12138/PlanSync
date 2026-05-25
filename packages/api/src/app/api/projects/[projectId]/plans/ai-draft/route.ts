import { NextRequest, NextResponse } from 'next/server';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { aiClient } from '@/lib/ai/client';
import { PLAN_DRAFT_TOOL, planDraftResultZ } from '@/lib/ai/schemas';
import { UNTRUSTED_INPUT_PREAMBLE, tagUntrusted } from '@/lib/ai/sanitize';
import { z } from 'zod';

type Params = { params: Promise<{ projectId: string }> };

const bodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
});

// Issue #821: R-188 untrusted-input contract on every system prompt so
// the model is consistent across capabilities about how to treat
// <untrusted> spans. The body's "Return ONLY valid JSON" hint is
// redundant under R-185 tool_use but kept for the text-mode fallback
// path.
const SYSTEM = `${UNTRUSTED_INPUT_PREAMBLE}

You are PlanSync AI. Generate a structured software project plan draft.
Return ONLY valid JSON — no explanation, no markdown fences. Use this exact shape:
{
  "goal": "string — what this plan version is trying to achieve (2-4 sentences)",
  "scope": "string — what is in and out of scope (2-4 sentences)",
  "constraints": ["string", ...],
  "standards": ["string", ...],
  "deliverables": ["string", ...],
  "openQuestions": ["string", ...]
}
Be specific and actionable. Each array should have 3-6 items. Write in English.`;

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    if (!aiClient.isAvailable) {
      return NextResponse.json(
        { error: 'AI not configured. Set LLM_API_KEY or ANTHROPIC_API_KEY.' },
        { status: 503 },
      );
    }

    const body = bodySchema.parse(await req.json());
    // Issue #821 / #825: title + description are user-controlled. Wrap
    // both so an attacker can't inject prompt-override instructions via
    // the plan title or the optional context field.
    const userMsg =
      `Project plan title: ${tagUntrusted(body.title, 'user')}` +
      (body.description ? `\nContext: ${tagUntrusted(body.description, 'user')}` : '') +
      '\n\nGenerate a complete plan draft as JSON.';

    // R-185: tool_use strict mode forces the 6 required fields at the
    // decoding layer. zod.safeParse below is the application-level safety
    // net (covers mock provider + text-mode fallback + future schema drift).
    const raw = await aiClient.complete(SYSTEM, userMsg, {
      purpose: 'plan_ai_draft',
      tool: PLAN_DRAFT_TOOL,
    });
    if (!raw) {
      return NextResponse.json({ error: 'AI returned no response' }, { status: 502 });
    }

    let draft: unknown;
    try {
      draft = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'AI response was not valid JSON', raw }, { status: 502 });
    }

    const safe = planDraftResultZ.safeParse(draft);
    if (!safe.success) {
      return NextResponse.json(
        {
          error: 'AI response did not match the required plan-draft schema',
          issues: safe.error.flatten(),
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ draft: safe.data });
  } catch (error) {
    return handleApiError(error);
  }
}
