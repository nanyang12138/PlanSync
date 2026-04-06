import { prisma } from '@/lib/prisma';
import { aiClient } from './client';
import { CHAT_SYSTEM, buildChatUserMessage } from './prompts/chat.prompt';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export async function buildChatContext(projectId: string) {
  const [project, activePlan, tasks, driftAlerts] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }),
    prisma.plan.findFirst({
      where: { projectId, status: 'active' },
      select: {
        version: true,
        title: true,
        goal: true,
        scope: true,
        constraints: true,
        standards: true,
        deliverables: true,
      },
    }),
    prisma.task.findMany({
      where: { projectId },
      select: { title: true, status: true, assignee: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    prisma.driftAlert.findMany({
      where: { projectId, status: 'open' },
      include: { task: { select: { title: true } } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const done = tasks.filter((t) => t.status === 'done').length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const todo = tasks.filter((t) => t.status === 'todo').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;

  return {
    projectName: project?.name ?? 'Unknown Project',
    activePlan: activePlan
      ? {
          ...activePlan,
          constraints: (activePlan.constraints as string[]) ?? [],
          standards: (activePlan.standards as string[]) ?? [],
          deliverables: (activePlan.deliverables as string[]) ?? [],
        }
      : null,
    taskSummary: {
      total: tasks.length,
      done,
      inProgress,
      todo,
      blocked,
      items: tasks.map((t) => ({ title: t.title, status: t.status, assignee: t.assignee })),
    },
    driftAlerts: driftAlerts.map((d) => ({
      taskTitle: d.task.title,
      severity: d.severity,
      reason: d.reason,
    })),
  };
}

export async function chat(
  projectId: string,
  message: string,
  history: ChatMessage[],
): Promise<{ reply: string | null; aiAvailable: boolean }> {
  if (!aiClient.isAvailable) {
    return { reply: null, aiAvailable: false };
  }

  const context = await buildChatContext(projectId);
  const userMessage = buildChatUserMessage(message, history, context);
  const reply = await aiClient.complete(CHAT_SYSTEM, userMessage);

  return { reply, aiAvailable: true };
}
