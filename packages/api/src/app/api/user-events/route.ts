import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/lib/auth';
import { eventBus, PlanSyncEvent } from '@/lib/event-bus';
import { logger } from '@/lib/logger';

const MAX_SSE_CLIENTS = 1000;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  let auth;
  try {
    auth = await authenticate(req);
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }

  if (eventBus.getClientCount() >= MAX_SSE_CLIENTS) {
    return new Response('Too many SSE connections', { status: 503 });
  }

  // Get all projects where this user is a human member
  const memberships = await prisma.projectMember.findMany({
    where: { name: auth.userName, type: 'human' },
    include: { project: { select: { id: true, name: true } } },
  });

  const encoder = new TextEncoder();
  const unsubscribers: Array<() => void> = [];

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));

      let eventId = 0;

      const forward = (event: PlanSyncEvent, projectId: string, projectName: string) => {
        eventId++;
        const enrichedData = { ...event.data, projectId, projectName };
        const payload = [
          `id: ${eventId}`,
          `event: ${event.type}`,
          `data: ${JSON.stringify(enrichedData)}`,
          '',
          '',
        ].join('\n');
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          logger.debug('SSE client disconnected during write');
        }
      };

      for (const membership of memberships) {
        const { id: pid, name: pname } = membership.project;
        const unsub = eventBus.subscribe(pid, (event: PlanSyncEvent) => {
          forward(event, pid, pname);
        });
        unsubscribers.push(unsub);
      }

      // Also subscribe to the per-user channel so events about the user
      // themselves (e.g. being added to a brand-new project) reach this
      // stream even though no project subscription covers them. The user
      // channel events carry their own projectId/projectName in the payload
      // — forward them through the same SSE stream.
      const userUnsub = eventBus.subscribeUser(auth.userName, (event: PlanSyncEvent) => {
        const pname = (event.data.projectName as string | undefined) ?? '';
        forward(event, event.projectId, pname);
      });
      unsubscribers.push(userUnsub);
    },
    cancel() {
      for (const unsub of unsubscribers) unsub();
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
