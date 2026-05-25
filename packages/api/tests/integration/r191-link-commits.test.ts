/**
 * R-191: commit ↔ deliverable linker.
 *
 * Acceptance from REMEDIATION_PLAN.md:
 *   "vitest：构造一个 push 事件 → 文件命中 deliverable A 的 glob →
 *    写入 CommitDeliverableLink(sha, A, matchedBy='glob')；带
 *    [deliverable:slug] 的 commit → matchedBy='message'"
 *
 * The link function lives at packages/api/src/lib/git/link-commits.ts.
 * It takes the GitHub `push` payload (as persisted in the outbox by
 * R-190) plus the project id and writes one row per (commit, deliverable,
 * match reason) into `commit_deliverable_links`. Re-delivery of the same
 * event must be a no-op.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { linkCommitsFromPushPayload, globToRegExp } from '@/lib/git/link-commits';

const prisma = new PrismaClient();

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

let projectId: string;
let planId: string;
let deliverableA: { id: string; slug: string };
let deliverableB: { id: string; slug: string };
let deliverableFree: { id: string; slug: string };

beforeAll(async () => {
  const suffix = uniqueSuffix();
  const project = await prisma.project.create({
    data: {
      name: `r191-${suffix}`,
      phase: 'active',
      createdBy: 'r191-owner',
    },
  });
  projectId = project.id;

  const plan = await prisma.plan.create({
    data: {
      projectId,
      version: 1,
      title: 'r191 plan v1',
      goal: 'g',
      scope: 's',
      deliverables: ['api docs', 'web ui'],
      status: 'active',
      createdBy: 'r191-owner',
      activatedAt: new Date(),
      activatedBy: 'r191-owner',
    },
  });
  planId = plan.id;

  // Two glob-backed deliverables and one free-form so we can prove that
  // (a) glob matches fire only for the matching files, and (b) free-form
  // deliverables are completely ignored by the glob path.
  const a = await prisma.planDeliverable.create({
    data: {
      planId,
      slug: 'api-docs',
      title: 'API docs',
      body: 'all markdown under docs/api',
      refType: 'file_glob',
      refUri: 'docs/api/**/*.md',
      status: 'active',
    },
  });
  const b = await prisma.planDeliverable.create({
    data: {
      planId,
      slug: 'web-ui',
      title: 'Web UI',
      body: 'web source',
      refType: 'file_glob',
      refUri: 'packages/web/src/**/*.tsx',
      status: 'active',
    },
  });
  const free = await prisma.planDeliverable.create({
    data: {
      planId,
      slug: 'free-form',
      title: 'Free-form',
      body: 'no refUri at all',
      refType: 'free',
      refUri: null,
      status: 'active',
    },
  });
  deliverableA = { id: a.id, slug: a.slug };
  deliverableB = { id: b.id, slug: b.slug };
  deliverableFree = { id: free.id, slug: free.slug };
});

afterAll(async () => {
  await prisma.commitDeliverableLink.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
  await prisma.$disconnect();
});

describe('R-191: globToRegExp helper', () => {
  it('matches the basic single-segment wildcard', () => {
    const re = globToRegExp('docs/*.md');
    expect(re.test('docs/foo.md')).toBe(true);
    expect(re.test('docs/foo.txt')).toBe(false);
    // single-* must not cross path separators
    expect(re.test('docs/sub/foo.md')).toBe(false);
  });

  it('treats `**` as cross-segment wildcard', () => {
    const re = globToRegExp('docs/api/**/*.md');
    expect(re.test('docs/api/foo.md')).toBe(true);
    expect(re.test('docs/api/v1/foo.md')).toBe(true);
    expect(re.test('docs/api/v1/v2/foo.md')).toBe(true);
    expect(re.test('docs/other/foo.md')).toBe(false);
    expect(re.test('docs/api/foo.txt')).toBe(false);
  });

  it('escapes regex meta characters', () => {
    const re = globToRegExp('docs/a.b+c/*.md');
    // The `.` and `+` must be literal — only `*` is a wildcard.
    expect(re.test('docs/a.b+c/x.md')).toBe(true);
    expect(re.test('docs/aXbYc/x.md')).toBe(false);
  });
});

describe('R-191: linkCommitsFromPushPayload', () => {
  it('writes a glob-match row when a commit touches a file matched by deliverable.refUri', async () => {
    const sha = 'aaa1111100000000000000000000000000000001';

    const result = await linkCommitsFromPushPayload({
      projectId,
      payload: {
        ref: 'refs/heads/main',
        commits: [
          {
            id: sha,
            message: 'docs: add /users endpoint',
            added: ['docs/api/users.md'],
            modified: [],
            removed: [],
          },
        ],
      },
    });

    expect(result.created).toBe(1);
    expect(result.commitsExamined).toBe(1);
    expect(result.byCommit[0]).toMatchObject({ sha, globMatches: 1, messageMatches: 0 });

    const rows = await prisma.commitDeliverableLink.findMany({
      where: { sha },
      orderBy: { matchedBy: 'asc' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId,
      sha,
      deliverableId: deliverableA.id,
      matchedBy: 'glob',
      matchedRef: 'docs/api/users.md',
    });
  });

  it('writes a message-match row when the commit message contains [deliverable:<slug>]', async () => {
    const sha = 'bbb2222200000000000000000000000000000002';

    const result = await linkCommitsFromPushPayload({
      projectId,
      payload: {
        commits: [
          {
            id: sha,
            // No file overlap with any refUri glob; the only signal is
            // the deliverable tag in the commit message.
            message: 'chore: tweak release notes [deliverable:web-ui]',
            added: ['CHANGELOG.md'],
            modified: [],
            removed: [],
          },
        ],
      },
    });

    expect(result.created).toBe(1);
    expect(result.byCommit[0]).toMatchObject({ sha, globMatches: 0, messageMatches: 1 });

    const rows = await prisma.commitDeliverableLink.findMany({ where: { sha } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId,
      sha,
      deliverableId: deliverableB.id,
      matchedBy: 'message',
      matchedRef: 'web-ui',
    });
  });

  it('emits both a glob row and a message row when both reasons apply to the same (sha, deliverable)', async () => {
    const sha = 'ccc3333300000000000000000000000000000003';

    const result = await linkCommitsFromPushPayload({
      projectId,
      payload: {
        commits: [
          {
            id: sha,
            message: 'docs: rewrite [deliverable:api-docs]',
            added: ['docs/api/v2/intro.md'],
            modified: [],
            removed: [],
          },
        ],
      },
    });

    // 1 glob + 1 message = 2 distinct rows (different matched_by).
    expect(result.created).toBe(2);
    expect(result.byCommit[0]).toMatchObject({ sha, globMatches: 1, messageMatches: 1 });

    const rows = await prisma.commitDeliverableLink.findMany({
      where: { sha },
      orderBy: { matchedBy: 'asc' },
    });
    expect(rows.map((r) => r.matchedBy)).toEqual(['glob', 'message']);
    expect(rows.every((r) => r.deliverableId === deliverableA.id)).toBe(true);
  });

  it('is idempotent: re-delivering the same push event creates no new rows', async () => {
    const sha = 'ddd4444400000000000000000000000000000004';
    const payload = {
      commits: [
        {
          id: sha,
          message: 'feat: add Users page [deliverable:web-ui]',
          added: ['packages/web/src/pages/Users.tsx'],
          modified: [],
          removed: [],
        },
      ],
    };

    const first = await linkCommitsFromPushPayload({ projectId, payload });
    expect(first.created).toBe(2); // glob (Web UI) + message (Web UI)

    const second = await linkCommitsFromPushPayload({ projectId, payload });
    // `skipDuplicates: true` means a re-deliver returns count = 0
    // because the unique (sha, deliverable, matched_by) constraint
    // rejects each row.
    expect(second.created).toBe(0);

    const rows = await prisma.commitDeliverableLink.findMany({ where: { sha } });
    expect(rows).toHaveLength(2);
  });

  it('ignores commits that touch no globbed files and carry no deliverable tag', async () => {
    const sha = 'eee5555500000000000000000000000000000005';
    const result = await linkCommitsFromPushPayload({
      projectId,
      payload: {
        commits: [
          {
            id: sha,
            message: 'chore: bump deps',
            added: ['package-lock.json'],
            modified: ['package.json'],
            removed: [],
          },
        ],
      },
    });
    expect(result.created).toBe(0);
    expect(result.byCommit[0]).toMatchObject({ sha, globMatches: 0, messageMatches: 0 });

    const rows = await prisma.commitDeliverableLink.findMany({ where: { sha } });
    expect(rows).toHaveLength(0);
  });

  it('ignores `[deliverable:<slug>]` tags whose slug does not exist in this project', async () => {
    const sha = 'fff6666600000000000000000000000000000006';
    const result = await linkCommitsFromPushPayload({
      projectId,
      payload: {
        commits: [
          {
            id: sha,
            message: 'chore: pretend [deliverable:does-not-exist]',
            added: ['unrelated.txt'],
            modified: [],
            removed: [],
          },
        ],
      },
    });
    expect(result.created).toBe(0);
    expect(result.byCommit[0].messageMatches).toBe(0);
  });

  it('does not match free-form deliverables (refType != "file_glob") even if refUri were set', async () => {
    // Sanity check: the `free` deliverable above has refType='free' and
    // refUri=null. Even if a commit touches a path that "looks" like a
    // glob hit, no row should fire from the free deliverable.
    const sha = 'aaa7777700000000000000000000000000000007';
    await linkCommitsFromPushPayload({
      projectId,
      payload: {
        commits: [
          {
            id: sha,
            message: 'chore: nothing important',
            added: ['anything-at-all.txt'],
            modified: [],
            removed: [],
          },
        ],
      },
    });
    const rows = await prisma.commitDeliverableLink.findMany({
      where: { sha, deliverableId: deliverableFree.id },
    });
    expect(rows).toHaveLength(0);
  });

  it('dedupes head_commit and commits[] when GitHub repeats the top commit in both', async () => {
    const sha = 'aaa8888800000000000000000000000000000008';
    const headCommit = {
      id: sha,
      message: 'docs: top [deliverable:api-docs]',
      added: ['docs/api/top.md'],
      modified: [],
      removed: [],
    };

    const result = await linkCommitsFromPushPayload({
      projectId,
      payload: {
        head_commit: headCommit,
        commits: [headCommit],
      },
    });

    expect(result.commitsExamined).toBe(1);
    // 1 glob row + 1 message row, despite the duplicate commit entries.
    expect(result.created).toBe(2);
  });

  it('handles multiple commits in one push and reports per-commit breakdown', async () => {
    const shaG = 'bbb9999900000000000000000000000000000009';
    const shaM = 'ccc9999900000000000000000000000000000010';
    const shaNoop = 'ddd9999900000000000000000000000000000011';

    const result = await linkCommitsFromPushPayload({
      projectId,
      payload: {
        commits: [
          {
            id: shaG,
            message: 'docs: glob only',
            added: ['docs/api/glob-only.md'],
            modified: [],
            removed: [],
          },
          {
            id: shaM,
            message: 'chore: msg only [deliverable:api-docs]',
            added: ['CHANGELOG.md'],
            modified: [],
            removed: [],
          },
          {
            id: shaNoop,
            message: 'chore: nothing',
            added: ['README.md'],
            modified: [],
            removed: [],
          },
        ],
      },
    });

    expect(result.commitsExamined).toBe(3);
    expect(result.created).toBe(2);

    const byCommit = Object.fromEntries(result.byCommit.map((c) => [c.sha, c]));
    expect(byCommit[shaG]).toMatchObject({ globMatches: 1, messageMatches: 0 });
    expect(byCommit[shaM]).toMatchObject({ globMatches: 0, messageMatches: 1 });
    expect(byCommit[shaNoop]).toMatchObject({ globMatches: 0, messageMatches: 0 });
  });
});
