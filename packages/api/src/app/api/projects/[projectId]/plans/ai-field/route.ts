import { NextRequest, NextResponse } from 'next/server';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { aiClient } from '@/lib/ai/client';
import { z } from 'zod';

type Params = { params: { projectId: string } };

const ARRAY_FIELDS = ['constraints', 'standards', 'deliverables', 'openQuestions'] as const;
type ArrayField = (typeof ARRAY_FIELDS)[number];
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

export async function POST(req: NextRequest, { params }: Params) {
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

    const system = `You are PlanSync AI helping write a project plan. Be concise and direct. Write in English. ${FIELD_INSTRUCTIONS[field as PlanField]}`;

    const context = [
      `Plan title: "${title}"`,
      goal && field !== 'goal' ? `Goal: ${goal}` : null,
      currentValue.trim() ? `Current value:\n${currentValue}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const userMsg = `${context}\n\nImprove or generate this field. Return only the content, nothing else.`;

    const suggestion = await aiClient.complete(system, userMsg);
    if (!suggestion) {
      return NextResponse.json({ error: 'AI returned no response' }, { status: 502 });
    }

    return NextResponse.json({ suggestion });
  } catch (error) {
    return handleApiError(error);
  }
}
