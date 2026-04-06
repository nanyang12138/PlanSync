import { NextRequest, NextResponse } from 'next/server';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { chat } from '@/lib/ai/chat';
import { z } from 'zod';

type Params = { params: { projectId: string } };

const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      }),
    )
    .max(20)
    .default([]),
});

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    const body = chatSchema.parse(await req.json());
    const result = await chat(params.projectId, body.message, body.history);

    if (!result.aiAvailable || result.reply === null) {
      return NextResponse.json(
        { error: 'AI not configured. Set LLM_API_KEY or ANTHROPIC_API_KEY to enable PlanSync AI.' },
        { status: 503 },
      );
    }

    return NextResponse.json({ reply: result.reply });
  } catch (error) {
    return handleApiError(error);
  }
}
