import { NextRequest } from 'next/server';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { eventBus, PlanSyncEvent } from '@/lib/event-bus';
import { logger } from '@/lib/logger';

const MAX_SSE_CLIENTS = 1000;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: { projectId: string } }) {
  try {
    // EventSource cannot set headers; clients may use ?token=<PLANSYNC_SECRET>&user=<name> (see authenticate).
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }

  if (eventBus.getClientCount() >= MAX_SSE_CLIENTS) {
    return new Response('Too many SSE connections', { status: 503 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));

      let eventId = 0;
      unsubscribe = eventBus.subscribe(params.projectId, (event: PlanSyncEvent) => {
        eventId++;
        const payload = [
          `id: ${eventId}`,
          `event: ${event.type}`,
          `data: ${JSON.stringify(event.data)}`,
          '',
          '',
        ].join('\n');
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          logger.debug('SSE client disconnected during write');
        }
      });
    },
    cancel() {
      if (unsubscribe) unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
