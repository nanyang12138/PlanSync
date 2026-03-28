import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { eventBus } from '@/lib/event-bus';

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: 'connected',
      sseClients: eventBus.getClientCount(),
    });
  } catch {
    return NextResponse.json(
      { status: 'error', timestamp: new Date().toISOString(), database: 'disconnected' },
      { status: 503 },
    );
  }
}
