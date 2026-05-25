import { NextRequest, NextResponse } from 'next/server';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { aiClient } from '@/lib/ai/client';
import { normalizeAiList, normalizeAiText } from '@/lib/ai/validate';
import { UNTRUSTED_INPUT_PREAMBLE, tagUntrusted } from '@/lib/ai/sanitize';
import { z } from 'zod';

type Params = { params: Promise<{ projectId: string }> };

type ArrayField = 'constraints' | 'standards' | 'deliverables' | 'openQuestions';
type TextField = 'goal' | 'scope';
type PlanField = TextField | ArrayField;

const bodySchema = z.object({
  field: z.enum(['goal', 'scope', 'constraints', 'standards', 'deliverables', 'openQuestions']),
  currentValue: z.string().max(5000),
  title: z.string().min(1).max(200),
  goal: z.string().max(2000).optional(),
});

const FIELD_INSTRUCTIONS: Record<PlanField, string> = {
  goal: 'Improve or generate the Goal field (2-4 sentences describing what this plan aims to achieve). Return plain text.',
  scope:
    'Improve or generate the Scope field (2-4 sentences on boundaries and inclusions/exclusions). Return plain text.',
  constraints:
    'Generate or improve the Constraints list (technical/resource/time constraints). Return one item per line, no bullets or numbers.',
  standards:
    'Generate or improve the Standards list (coding standards, quality bar, compliance requirements). Return one item per line, no bullets or numbers.',
  deliverables:
    'Generate or improve the Deliverables list (concrete outputs at completion). Return one item per line, no bullets or numbers.',
  openQuestions:
    'Generate or improve the Open Questions list (unresolved decisions that need answers). Return one item per line, no bullets or numbers.',
};

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
    const { field, currentValue, title, goal } = body;

    // Issue #825: prepend the untrusted-input contract so the model
    // refuses to act on injection inside the wrapped spans below.
    const system = `${UNTRUSTED_INPUT_PREAMBLE}\n\nYou are PlanSync AI helping write a project plan. Be concise and direct. Write in English. ${FIELD_INSTRUCTIONS[field as PlanField]}`;

    // Issue #825: every user/DB-derived field below is wrapped. Without
    // this, a hostile plan title or current-value text could rewrite
    // the system instructions and trick the field improver into
    // emitting unrelated content.
    const context = [
      `Plan title: ${tagUntrusted(title, 'plan')}`,
      goal && field !== 'goal' ? `Goal: ${tagUntrusted(goal, 'plan')}` : null,
      currentValue.trim() ? `Current value:\n${tagUntrusted(currentValue, 'plan')}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const userMsg = `${context}\n\nImprove or generate this field. Return only the content, nothing else.`;

    const suggestion = await aiClient.complete(system, userMsg, { purpose: 'plan_ai_field' });
    if (!suggestion) {
      return NextResponse.json({ error: 'AI returned no response' }, { status: 502 });
    }

    // R-186: this is the one AI endpoint that doesn't switch to tool_use
    // (each request emits a single text field, not a structured object).
    // Apply the validate-layer post-processors so the model can't slip in
    // markdown bullets / numbered lists / overflowing text that confuses
    // the downstream UI list editor.
    let normalized: string;
    if (field === 'goal' || field === 'scope') {
      normalized = normalizeAiText(suggestion, 2000);
    } else {
      normalized = normalizeAiList(suggestion, 20).join('\n');
    }

    return NextResponse.json({ suggestion: normalized });
  } catch (error) {
    return handleApiError(error);
  }
}
