import { prisma } from './prisma';
import { logger } from './logger';

/**
 * R-135 audit helper. Call after a `findFirst({ id, projectId })` returned
 * null but BEFORE returning a 404 to the caller. If the task does exist
 * in a different project, this emits a `suspectCrossProject` audit warn
 * so the owner can detect probing without exposing existence to the
 * requester (the response stays a generic 404).
 *
 * Reviewer-driven (#255 / #256): every write path (claim, decline,
 * PATCH, complete-human, runs POST, rebind, DELETE) and the GET /pack
 * route should emit the same audit signal that `buildTaskPack()`
 * already does, so cross-project probes are visible regardless of
 * which surface the caller targets.
 *
 * The audit query runs only on the not-found path, so the happy path
 * is unaffected.
 */
export async function auditCrossProjectTaskIfNeeded(
  taskId: string,
  projectId: string,
  callContext: string,
): Promise<void> {
  const cross = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true },
  });
  if (cross && cross.projectId !== projectId) {
    logger.warn(
      {
        suspectCrossProject: true,
        callContext,
        taskId,
        requestedProjectId: projectId,
        actualProjectId: cross.projectId,
      },
      'cross-project task lookup rejected',
    );
  }
}
