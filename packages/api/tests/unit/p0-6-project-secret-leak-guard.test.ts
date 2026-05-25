/**
 * P0-6 / closes #780 #796 — `Project.githubWebhookSecret` must not leak
 * through any user-facing project read.
 *
 * The secret is the HMAC shared key used by the GitHub webhook receiver
 * to verify incoming deliveries. If a project member can read it from
 * `GET /api/projects` or `GET /api/projects/:id` they can forge GitHub
 * webhook payloads to that project (e.g. fake `pull_request_review`
 * events to drive R-192 task auto-state).
 *
 * The fix is the centralized `PROJECT_PUBLIC_SELECT` projection in
 * `@/lib/prisma`, which deliberately omits `githubWebhookSecret`. This
 * test asserts:
 *   1. The constant exists and explicitly does not include the column.
 *   2. The constant cannot be silently widened to include it (so a
 *      future careless edit fails CI).
 */
import { describe, it, expect } from 'vitest';
import { PROJECT_PUBLIC_SELECT } from '../../src/lib/prisma';

describe('P0-6 PROJECT_PUBLIC_SELECT does not leak githubWebhookSecret', () => {
  it('omits githubWebhookSecret from the public projection', () => {
    expect('githubWebhookSecret' in PROJECT_PUBLIC_SELECT).toBe(false);
  });

  it('keeps the documented public columns', () => {
    const expected = [
      'id',
      'name',
      'description',
      'phase',
      'repoUrl',
      'defaultBranch',
      'githubRepo',
      'createdBy',
      'createdAt',
      'updatedAt',
    ];
    for (const f of expected) {
      expect(PROJECT_PUBLIC_SELECT[f as keyof typeof PROJECT_PUBLIC_SELECT]).toBe(true);
    }
  });
});
