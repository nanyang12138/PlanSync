/**
 * R-193 — PR template auto-injection of deliverable refs + drift status.
 *
 * Fix step from the remediation plan:
 *   GitHub Action 在 PR 创建/更新时，update PR body 一段
 *   `<!-- plansync-status -->...<!-- /plansync-status -->`
 *
 * Verification (from the plan):
 *   action 集成测试：构造 PR 事件 → 调用 mock GitHub API → 看到 PR body 被
 *   注入 `<!-- plansync-status -->` 块；二次运行只更新块内内容、不重复追加
 *
 * These tests cover the three load-bearing properties:
 *   1. Pure-function block rendering and idempotent injection (`renderPlansyncStatusBlock`,
 *      `injectPlansyncBlock`) so the contract is testable without a network.
 *   2. The `syncPrBody` GitHub API round-trip (mocked fetch) including the
 *      no-op short-circuit when the body would not change.
 *   3. End-to-end `run()` behaviour: skips silently when any of the three
 *      `github-token` / `repo` / `pr-number` inputs is missing; injects on
 *      the first run and replaces in place on the second.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CoreMock = {
  getInput: ReturnType<typeof vi.fn>;
  setSecret: ReturnType<typeof vi.fn>;
  setOutput: ReturnType<typeof vi.fn>;
  setFailed: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warning: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

const coreMock: CoreMock = {
  getInput: vi.fn(),
  setSecret: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
};

vi.mock('@actions/core', () => coreMock);

type InputMap = Record<string, string>;
function configureInputs(inputs: InputMap) {
  coreMock.getInput.mockImplementation((name: string) => inputs[name] ?? '');
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('R-193 pure helpers', () => {
  it('R193-P1: renderPlansyncStatusBlock wraps the content with the marker tags and includes drift + plan + gate', async () => {
    const { renderPlansyncStatusBlock } = await import('../index');
    const block = renderPlansyncStatusBlock({
      projectId: 'proj-xyz',
      planVersion: 3,
      drifts: [
        { id: 'd1', severity: 'high', taskId: 't1', reason: 'plan changed' },
        { id: 'd2', severity: 'medium', taskId: 't2' },
      ],
      semanticGate: 'passed',
      deliverableGlobs: ['src/**/*.ts', 'docs/**/*.md'],
      unmatchedFiles: [],
      scopedTaskIds: ['t1', 't2'],
      truncatedTaskScan: false,
      truncatedDriftScan: false,
      driftScan: 'ok',
    });

    // Tag delimiters present (parser anchor).
    expect(block.startsWith('<!-- plansync-status -->')).toBe(true);
    expect(block.trimEnd().endsWith('<!-- /plansync-status -->')).toBe(true);

    // Core facts surfaced in the block.
    expect(block).toContain('PlanSync Status');
    expect(block).toContain('v3');
    expect(block).toMatch(/2 open alert\(s\) — 1 high · 1 medium/);
    expect(block).toContain('Deliverable gate');
    expect(block).toContain('passed');
    expect(block).toContain('src/**/*.ts');
    expect(block).toContain('proj-xyz');
    expect(block).toContain('t1');
  });

  it('R193-P2: renderPlansyncStatusBlock degrades gracefully when no plan is active and no scope is set', async () => {
    const { renderPlansyncStatusBlock } = await import('../index');
    const block = renderPlansyncStatusBlock({
      projectId: 'proj-empty',
      planVersion: null,
      drifts: [],
      semanticGate: 'skipped',
      deliverableGlobs: [],
      unmatchedFiles: [],
      scopedTaskIds: null,
      truncatedTaskScan: false,
      truncatedDriftScan: false,
      // #2753: caller observed a clean drift scan, so the block should
      // explicitly say "no open alerts in scope" (not "not evaluated").
      driftScan: 'ok',
    });
    expect(block).toMatch(/none — activate a plan/);
    expect(block).toContain('project-wide');
    expect(block).toContain('no open alerts in scope');
    expect(block).toContain('skipped');
  });

  it('R193-P3: injectPlansyncBlock appends when the markers are absent', async () => {
    const { injectPlansyncBlock } = await import('../index');
    const body = '## Description\n\nFixes #123.';
    const block = '<!-- plansync-status -->\nfoo\n<!-- /plansync-status -->';
    const result = injectPlansyncBlock(body, block);
    expect(result.startsWith('## Description')).toBe(true);
    expect(result.endsWith('<!-- /plansync-status -->')).toBe(true);
    expect(result).toContain('foo');
    // Author content is preserved verbatim.
    expect(result).toContain('Fixes #123.');
  });

  it('R193-P4: injectPlansyncBlock replaces the block in place on the second pass (no duplication)', async () => {
    const { injectPlansyncBlock } = await import('../index');
    const seed =
      '## Description\n\nFixes #123.\n\n<!-- plansync-status -->\nOLD CONTENT\n<!-- /plansync-status -->';
    const newBlock = '<!-- plansync-status -->\nNEW CONTENT\n<!-- /plansync-status -->';
    const first = injectPlansyncBlock(seed, newBlock);
    // Should contain exactly one block, with the NEW content.
    expect(first.match(/<!-- plansync-status -->/g)?.length ?? 0).toBe(1);
    expect(first.match(/<!-- \/plansync-status -->/g)?.length ?? 0).toBe(1);
    expect(first).toContain('NEW CONTENT');
    expect(first).not.toContain('OLD CONTENT');
    // And running it once more is a no-op.
    const second = injectPlansyncBlock(first, newBlock);
    expect(second).toBe(first);
  });

  it('R193-P5: injectPlansyncBlock handles null / empty bodies by returning just the block', async () => {
    const { injectPlansyncBlock } = await import('../index');
    const block = '<!-- plansync-status -->\nx\n<!-- /plansync-status -->';
    expect(injectPlansyncBlock(null, block)).toBe(block);
    expect(injectPlansyncBlock(undefined, block)).toBe(block);
    expect(injectPlansyncBlock('', block)).toBe(block);
  });
});

describe('R-193 syncPrBody (mocked GitHub API)', () => {
  it('R193-S1: GETs the PR body and PATCHes it with the rendered block when missing', async () => {
    const { syncPrBody } = await import('../index');
    const fetchImpl = vi.fn();
    // GET → empty body
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, { body: '## Description\n\nFixes #1' }));
    // PATCH → 200
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, {}));

    const result = await syncPrBody(
      {
        projectId: 'p1',
        planVersion: 7,
        drifts: [],
        semanticGate: 'passed',
        deliverableGlobs: ['a.ts'],
        unmatchedFiles: [],
        scopedTaskIds: null,
        truncatedTaskScan: false,
        truncatedDriftScan: false,
        driftScan: 'ok',
      },
      { repo: 'org/repo', prNumber: 42, token: 'ghp_test', fetchImpl },
    );

    expect(result.updated).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [getUrl, getOpts] = fetchImpl.mock.calls[0];
    expect(String(getUrl)).toBe('https://api.github.com/repos/org/repo/pulls/42');
    expect((getOpts as { headers: Record<string, string> }).headers.Authorization).toBe(
      'Bearer ghp_test',
    );

    const [patchUrl, patchOpts] = fetchImpl.mock.calls[1];
    expect(String(patchUrl)).toBe('https://api.github.com/repos/org/repo/pulls/42');
    expect((patchOpts as { method: string }).method).toBe('PATCH');
    const sent = JSON.parse((patchOpts as { body: string }).body) as { body: string };
    expect(sent.body).toContain('## Description');
    expect(sent.body).toContain('<!-- plansync-status -->');
    expect(sent.body).toContain('v7');
  });

  it('R193-S2: skips the PATCH when the block is already up-to-date (idempotent re-run)', async () => {
    const { syncPrBody, renderPlansyncStatusBlock, injectPlansyncBlock } = await import('../index');
    const status = {
      projectId: 'p1',
      planVersion: 7,
      drifts: [],
      semanticGate: 'passed' as const,
      deliverableGlobs: ['a.ts'],
      unmatchedFiles: [],
      scopedTaskIds: null,
      truncatedTaskScan: false,
      truncatedDriftScan: false,
      driftScan: 'ok' as const,
    };
    const block = renderPlansyncStatusBlock(status);
    const existing = injectPlansyncBlock('## Description\n\nFixes #1', block);

    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(jsonResponse(200, { body: existing }));

    const result = await syncPrBody(status, {
      repo: 'org/repo',
      prNumber: 42,
      token: 'ghp_test',
      fetchImpl,
    });

    expect(result.updated).toBe(false);
    expect(result.reason).toMatch(/no-op/);
    // Only the GET was issued; no PATCH.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('R193-S3: throws when the GET returns non-2xx so the action can surface a warning', async () => {
    const { syncPrBody } = await import('../index');
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
      new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
    );
    await expect(
      syncPrBody(
        {
          projectId: 'p1',
          planVersion: null,
          drifts: [],
          semanticGate: 'skipped',
          deliverableGlobs: [],
          unmatchedFiles: [],
          scopedTaskIds: null,
          truncatedTaskScan: false,
          truncatedDriftScan: false,
          driftScan: 'not_run',
        },
        { repo: 'org/repo', prNumber: 42, token: 'ghp_test', fetchImpl },
      ),
    ).rejects.toThrow(/403/);
  });
});

describe('R-193 #2753 drift-scan discriminator', () => {
  // Regression: before #2753 every early-return path in run() left
  // `status.drifts = []` and the rendered block silently claimed
  // "no open alerts in scope", lying to reviewers that the PR was
  // drift-clean when in fact the drift list was never consulted. These
  // tests pin the three terminal states for the new `driftScan` field.
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.values(coreMock).forEach((fn) => fn.mockReset());
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('R193-#2753-P1: renderPlansyncStatusBlock reports "not evaluated" when driftScan=not_run, even with drifts=[]', async () => {
    const { renderPlansyncStatusBlock } = await import('../index');
    const block = renderPlansyncStatusBlock({
      projectId: 'proj-skipped',
      planVersion: 4,
      drifts: [],
      semanticGate: 'failed',
      deliverableGlobs: ['src/**/*.ts'],
      unmatchedFiles: ['stray.md'],
      scopedTaskIds: null,
      truncatedTaskScan: false,
      truncatedDriftScan: false,
      driftScan: 'not_run',
    });
    expect(block).toContain('not evaluated');
    // The misleading legacy phrasing must NOT appear when no scan ran.
    expect(block).not.toContain('no open alerts in scope');
    // Other status lines (semantic gate, plan version, unmatched files)
    // are still rendered so the reviewer can see WHY drift was skipped.
    expect(block).toContain('v4');
    expect(block).toContain('failed');
    expect(block).toContain('stray.md');
  });

  it('R193-#2753-P2: renderPlansyncStatusBlock reports "partial scan" when driftScan=truncated', async () => {
    const { renderPlansyncStatusBlock } = await import('../index');
    const block = renderPlansyncStatusBlock({
      projectId: 'proj-trunc',
      planVersion: 1,
      drifts: [],
      semanticGate: 'passed',
      deliverableGlobs: [],
      unmatchedFiles: [],
      scopedTaskIds: null,
      truncatedTaskScan: false,
      truncatedDriftScan: true,
      driftScan: 'truncated',
    });
    expect(block).toContain('partial scan');
    expect(block).not.toContain('no open alerts in scope');
    // The footer warning is independently driven by truncatedDriftScan
    // and should still appear.
    expect(block).toContain('truncated its scan');
  });

  it('R193-#2753-R1: when the semantic gate FAILS, the PR body says "not evaluated" (not "no open alerts")', async () => {
    // This is the load-bearing regression: the original bug let a PR with
    // a failed deliverable gate write "Drift: no open alerts in scope"
    // into the PR body, telling reviewers the drift list was clean even
    // though `fetchOpenDrifts` was never called.
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'pr-files': 'random/stray.md',
      'github-token': 'ghp_test',
      repo: 'octo/example',
      'pr-number': '11',
    });
    // /plans/active → returns an active plan ...
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, { data: { id: 'plan-1', version: 2 } }),
    );
    // ... whose deliverables only cover src/**/*.ts, so `stray.md` is
    // unmatched and the semantic gate fails fast — short-circuiting the
    // drift fetch entirely.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [{ id: 'd-1', slug: 'core', refType: 'file_glob', refUri: 'src/**/*.ts', status: 'active' }],
      }),
    );
    // GitHub GET / PATCH for the finally-block PR-body sync.
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { body: '' }));
    let patchBody: string | undefined;
    fetchSpy.mockImplementationOnce(async (_url: string | URL, init?: RequestInit) => {
      patchBody = JSON.parse(String(init?.body)).body as string;
      return jsonResponse(200, {});
    });

    const { run } = await import('../index');
    await run();

    // The gate failed (so the action set its own failure verdict).
    expect(coreMock.setFailed).toHaveBeenCalled();
    // And the PR body got the block — but it must NOT lie about drift.
    expect(patchBody).toBeDefined();
    expect(patchBody!).toContain('<!-- plansync-status -->');
    expect(patchBody!).toContain('not evaluated');
    expect(patchBody!).not.toContain('no open alerts in scope');
    // No drift fetch should have been issued.
    const driftCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/drifts?status=open'),
    );
    expect(driftCalls).toHaveLength(0);
  });

  it('R193-#2753-R2: when the drift fetch throws, the PR body says "not evaluated"', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'github-token': 'ghp_test',
      repo: 'octo/example',
      'pr-number': '12',
    });
    // /drifts → 500 so fetchOpenDrifts throws.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(500, { error: { message: 'boom' } }),
    );
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { body: '' }));
    let patchBody: string | undefined;
    fetchSpy.mockImplementationOnce(async (_url: string | URL, init?: RequestInit) => {
      patchBody = JSON.parse(String(init?.body)).body as string;
      return jsonResponse(200, {});
    });

    const { run } = await import('../index');
    await run();

    expect(coreMock.setFailed).toHaveBeenCalled();
    expect(patchBody).toBeDefined();
    expect(patchBody!).toContain('not evaluated');
    expect(patchBody!).not.toContain('no open alerts in scope');
  });

  it('R193-#2753-R3: when the drift scan is truncated, the PR body says "partial scan" (not "no open alerts")', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'github-token': 'ghp_test',
      repo: 'octo/example',
      'pr-number': '13',
    });
    // Return a full page on every drift fetch so the pagination cap trips
    // (DRIFT_PAGE_SIZE=100, DRIFT_PAGE_CAP=50). Omitting `pagination`
    // exercises the legacy-server "partial-page heuristic" fallback.
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: `d-${i}`,
      taskId: `t-${i}`,
      severity: 'medium',
      taskBoundVersion: 1,
      currentPlanVersion: 2,
    }));
    for (let i = 0; i < 50; i += 1) {
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: fullPage }));
    }
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { body: '' }));
    let patchBody: string | undefined;
    fetchSpy.mockImplementationOnce(async (_url: string | URL, init?: RequestInit) => {
      patchBody = JSON.parse(String(init?.body)).body as string;
      return jsonResponse(200, {});
    });

    const { run } = await import('../index');
    await run();

    expect(coreMock.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('pagination cap'),
    );
    expect(patchBody).toBeDefined();
    expect(patchBody!).toContain('partial scan');
    expect(patchBody!).not.toContain('no open alerts in scope');
    // The footer truncation warning should also be present.
    expect(patchBody!).toContain('truncated its scan');
  });
});

describe('R-193 run() integration with GitHub API', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.values(coreMock).forEach((fn) => fn.mockReset());
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('R193-R1: skips PR-body sync silently when github-token / repo / pr-number are all missing', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const { run } = await import('../index');
    await run();

    // The only HTTP call is the drift fetch — no GitHub PATCH was attempted.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/drifts?status=open');
    expect(coreMock.setOutput).toHaveBeenCalledWith('pr-body-updated', 'false');
    // No warning either — opt-in feature is silent when unconfigured.
    const warnings = coreMock.warning.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes('PR-body sync'))).toBe(false);
  });

  it('R193-R2: warns and skips PR-body sync when only some of the three inputs are provided', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'github-token': 'ghp_test',
      // `repo` and `pr-number` intentionally omitted.
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const { run } = await import('../index');
    await run();

    // Still only the drift fetch happened.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const infos = coreMock.info.mock.calls.map((c) => String(c[0]));
    expect(infos.some((m) => m.includes('PlanSync PR-body sync skipped'))).toBe(true);
  });

  it('R193-R3: injects the PlanSync block on the first run, then replaces in place on the second (no duplication)', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'task-ids': 't1',
      'github-token': 'ghp_test',
      repo: 'octo/example',
      'pr-number': '7',
    });

    // ---- First run: PR body has no PlanSync block ----
    // Drift fetch — single in-scope MEDIUM drift so the gate stays green.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            id: 'd1',
            taskId: 't1',
            severity: 'medium',
            taskBoundVersion: 1,
            currentPlanVersion: 2,
          },
        ],
      }),
    );
    // GitHub GET
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { body: '## Description\n\nFixes #99.' }));
    // GitHub PATCH
    let firstPatchBody: string | undefined;
    fetchSpy.mockImplementationOnce(async (_url: string | URL, init?: RequestInit) => {
      firstPatchBody = JSON.parse(String(init?.body)).body as string;
      return jsonResponse(200, {});
    });

    const { run } = await import('../index');
    await run();

    expect(firstPatchBody).toBeDefined();
    // Description preserved + block appended exactly once.
    expect(firstPatchBody!).toContain('Fixes #99.');
    expect(firstPatchBody!.match(/<!-- plansync-status -->/g)?.length ?? 0).toBe(1);
    expect(firstPatchBody!).toMatch(/1 open alert\(s\)/);
    expect(coreMock.setOutput).toHaveBeenCalledWith('pr-body-updated', 'true');

    // Capture the body that GitHub would return on the next read.
    const updatedBodyAfterFirst = firstPatchBody!;

    // ---- Second run: PR body now contains the block; expect in-place replace ----
    Object.values(coreMock).forEach((fn) => fn.mockReset());
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'task-ids': 't1',
      'github-token': 'ghp_test',
      repo: 'octo/example',
      'pr-number': '7',
    });

    // Drift fetch — same state.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            id: 'd1',
            taskId: 't1',
            severity: 'medium',
            taskBoundVersion: 1,
            currentPlanVersion: 2,
          },
        ],
      }),
    );
    // GitHub GET returns the body we wrote on the first run.
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { body: updatedBodyAfterFirst }));
    // The block is unchanged → no PATCH should be issued. If a PATCH did
    // fire, the test would see an extra call below.

    await run();

    // Drift fetch + GET only — no PATCH.
    const githubCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith('https://api.github.com/'),
    );
    expect(githubCalls).toHaveLength(3); // 1 from first run GET+PATCH, plus 1 GET from second run
    const secondRunGithubCalls = githubCalls.slice(2);
    expect(secondRunGithubCalls).toHaveLength(1);
    expect((secondRunGithubCalls[0][1] as { method?: string } | undefined)?.method ?? 'GET').toBe(
      'GET',
    );
    // pr-body-updated reports false on the no-op re-run.
    expect(coreMock.setOutput).toHaveBeenCalledWith('pr-body-updated', 'false');
  });

  it('R193-R4: still injects the block when the drift gate FAILS (so reviewers see the failure context)', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'github-token': 'ghp_test',
      repo: 'octo/example',
      'pr-number': '99',
    });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            id: 'd-high',
            taskId: 't-h',
            severity: 'high',
            taskBoundVersion: 1,
            currentPlanVersion: 2,
          },
        ],
      }),
    );
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { body: null }));
    let patchBody: string | undefined;
    fetchSpy.mockImplementationOnce(async (_url: string | URL, init?: RequestInit) => {
      patchBody = JSON.parse(String(init?.body)).body as string;
      return jsonResponse(200, {});
    });

    const { run } = await import('../index');
    await run();

    // Drift gate failed → setFailed was called.
    expect(coreMock.setFailed).toHaveBeenCalledWith('High severity drift detected');
    // But the PR body still got the block (so the reviewer sees WHY).
    expect(patchBody).toBeDefined();
    expect(patchBody!).toContain('<!-- plansync-status -->');
    expect(patchBody!).toMatch(/1 open alert\(s\) — 1 high/);
  });

  it('R193-R5: warns and does not call the GitHub API when repo input is malformed', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'github-token': 'ghp_test',
      repo: 'just-a-slug-no-slash',
      'pr-number': '1',
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const { run } = await import('../index');
    await run();

    // Only the drift fetch went out.
    const githubCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith('https://api.github.com/'),
    );
    expect(githubCalls).toHaveLength(0);
    const warnings = coreMock.warning.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes('owner/name'))).toBe(true);
  });

  it('R193-R6: warns when pr-number is not a positive integer', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'github-token': 'ghp_test',
      repo: 'octo/example',
      'pr-number': 'not-a-number',
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const { run } = await import('../index');
    await run();

    const warnings = coreMock.warning.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes('positive integer'))).toBe(true);
  });

  it('R193-R7: PR-body sync failure is non-fatal — drift gate verdict still wins', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'github-token': 'ghp_test',
      repo: 'octo/example',
      'pr-number': '5',
    });
    // No drifts → green gate.
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    // GitHub GET fails with 502.
    fetchSpy.mockResolvedValueOnce(new Response('bad gateway', { status: 502 }));

    const { run } = await import('../index');
    await run();

    // setFailed was not called — the gate verdict (green) is preserved.
    expect(coreMock.setFailed).not.toHaveBeenCalled();
    const warnings = coreMock.warning.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes('PR-body sync failed'))).toBe(true);
  });

  it('R193-R8: masks the github-token via setSecret', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'github-token': 'ghp_supersecret_value',
      repo: 'octo/example',
      'pr-number': '5',
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { body: '' }));
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, {}));

    const { run } = await import('../index');
    await run();

    expect(coreMock.setSecret).toHaveBeenCalledWith('ghp_supersecret_value');
  });
});
