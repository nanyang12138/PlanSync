import { NextRequest, NextResponse } from 'next/server';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { aiClient } from '@/lib/ai/client';
import { z } from 'zod';

type Params = { params: { projectId: string } };

const bodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
});

const SYSTEM = `You are PlanSync AI. Generate a structured software project plan draft.
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
    const userMsg = `Project plan title: "${body.title}"${body.description ? `\nContext: ${body.description}` : ''}\n\nGenerate a complete plan draft as JSON.`;

    const raw = await aiClient.complete(SYSTEM, userMsg);
    if (!raw) {
      return NextResponse.json({ error: 'AI returned no response' }, { status: 502 });
    }

    let draft: unknown;
    try {
      draft = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'AI response was not valid JSON', raw }, { status: 502 });
    }

    return NextResponse.json({ draft });
  } catch (error) {
    return handleApiError(error);
  }
}
