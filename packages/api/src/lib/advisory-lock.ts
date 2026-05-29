import type { Prisma } from '@prisma/client';

/**
 * Hash a projectId string into a signed 64-bit int suitable for
 * `pg_advisory_xact_lock(bigint)`. The hash is stable and deterministic so two
 * concurrent requests for the same project always derive the same lock key.
 *
 * Extracted from the activate route as part of R-206 so the same key derivation
 * can serialize `plan_activate` against `execution_start` (and any future route
 * that needs project-scoped serialization). Both routes computing the same key
 * is what makes the lock actually exclude the right pair of operations.
 */
export function hashProjectIdToInt64(projectId: string): bigint {
  // FNV-1a 64-bit
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask64 = (1n << 64n) - 1n;
  for (let i = 0; i < projectId.length; i++) {
    hash = (hash ^ BigInt(projectId.charCodeAt(i))) & mask64;
    hash = (hash * prime) & mask64;
  }
  // Convert unsigned 64-bit to signed for PostgreSQL bigint.
  return hash >= 1n << 63n ? hash - (1n << 64n) : hash;
}

/**
 * Acquire a transaction-scoped advisory lock keyed by project id. Released
 * automatically when the enclosing `$transaction` commits or rolls back.
 *
 * Call this at the very top of any transaction that must serialize against
 * other writers on the same project (activate flipping plans; execution_start
 * claiming tasks; future bulk-rebind etc.). All call sites that pass the same
 * `projectId` will block each other; different projects never contend.
 */
export async function acquireProjectAdvisoryLock(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<void> {
  const lockKey = hashProjectIdToInt64(projectId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;
}
