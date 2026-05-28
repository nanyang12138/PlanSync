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
      driftScanStatus: 'completed',
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
      driftScanStatus: 'completed',
    });
    expect(block).toMatch(/none — activate a plan/);
    expect(block).toContain('project-wide');
    expect(block).toContain('no open alerts in scope');
    expect(block).toContain('skipped');
  });

  it('R193-P2b (#2768): renderPlansyncStatusBlock does NOT render "no open alerts" when drift was not run', async () => {
    const { renderPlansyncStatusBlock } = await import('../index');
    const notRun = renderPlansyncStatusBlock({
      projectId: 'proj-x',
      planVersion: 1,
      drifts: [],
      semanticGate: 'failed',
      deliverableGlobs: ['src/**/*.ts'],
      unmatchedFiles: ['rogue.txt'],
      scopedTaskIds: null,
      truncatedTaskScan: false,
      truncatedDriftScan: false,
      driftScanStatus: 'not_run',
    });
    expect(notRun).not.toContain('no open alerts in scope');
    expect(notRun).toMatch(/Drift.*not checked/);

    const failed = renderPlansyncStatusBlock({
      projectId: 'proj-x',
      planVersion: 1,
      drifts: [],
      semanticGate: 'passed',
      deliverableGlobs: [],
      unmatchedFiles: [],
      scopedTaskIds: null,
      truncatedTaskScan: false,
      truncatedDriftScan: true,
      driftScanStatus: 'failed',
    });
    expect(failed).not.toContain('no open alerts in scope');
    expect(failed).toMatch(/Drift.*check failed/);
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
        driftScanStatus: 'completed',
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
      driftScanStatus: 'completed' as const,
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
          driftScanStatus: 'completed',
        },
        { repo: 'org/repo', prNumber: 42, token: 'ghp_test', fetchImpl },
      ),
    ).rejects.toThrow(/403/);
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
    // #2754: plan-version fetch (best-effort, before PR-body sync).
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));
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
    // #2754: plan-version fetch (best-effort, before PR-body sync).
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));
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
    // #2754: plan-version fetch (best-effort, before PR-body sync).
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));
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
    // #2754: plan-version fetch (best-effort, before PR-body sync).
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));
    // GitHub GET fails with 502.
    fetchSpy.mockResolvedValueOnce(new Response('bad gateway', { status: 502 }));

    const { run } = await import('../index');
    await run();

    // setFailed was not called — the gate verdict (green) is preserved.
    expect(coreMock.setFailed).not.toHaveBeenCalled();
    const warnings = coreMock.warning.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes('PR-body sync failed'))).toBe(true);
  });

  it('R193-R7b (#2768): renders "check failed" instead of "no open alerts" when the drift query is truncated', async () => {
    // Spec: a truncated drift scan is an early-return path. Before the fix
    // the default `status.drifts = []` would render as "no open alerts in
    // scope" — a false-positive that misleads reviewers. The block must
    // surface that the check did not produce an authoritative result.
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'github-token': 'ghp_test',
      repo: 'octo/example',
      'pr-number': '11',
    });

    // Every drift page returns a full page with the totalPages field
    // pointing past the cap → `isLastPage` keeps returning false and the
    // loop exits with `truncated: true`.
    const fullPage = {
      data: Array.from({ length: 100 }, (_, i) => ({
        id: `d${i}`,
        taskId: `t${i}`,
        severity: 'medium',
        taskBoundVersion: 1,
        currentPlanVersion: 2,
      })),
      pagination: { page: 1, pageSize: 100, total: 999999, totalPages: 9999 },
    };
    // DRIFT_PAGE_CAP = 50 iterations before the loop bails out.
    for (let i = 0; i < 50; i += 1) {
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, fullPage));
    }
    // #2754: plan-version fetch (best-effort, before PR-body sync).
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));
    // GitHub GET — body is empty so the block will be appended.
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { body: '' }));
    // GitHub PATCH — capture the body so we can assert on the rendered block.
    let patchBody: string | undefined;
    fetchSpy.mockImplementationOnce(async (_url: string | URL, init?: RequestInit) => {
      patchBody = JSON.parse(String(init?.body)).body as string;
      return jsonResponse(200, {});
    });

    const { run } = await import('../index');
    await run();

    // The gate failed loudly (the existing behaviour we must preserve).
    expect(coreMock.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('exceeds pagination cap'),
    );
    // The status block was still written (so reviewers see context)…
    expect(patchBody).toBeDefined();
    expect(patchBody!).toContain('<!-- plansync-status -->');
    // …but it must NOT lie about the drift state.
    expect(patchBody!).not.toContain('no open alerts in scope');
    expect(patchBody!).toMatch(/Drift.*check failed/);
    expect(patchBody!).toContain('truncated its scan');
  });

  it('R193-R7c (#2768): renders "not checked" when the gate aborts before the drift query', async () => {
    // Spec: when the deliverable-load step errors out we bail before
    // calling `fetchOpenDrifts`. The status block must reflect that drift
    // was never checked, not that there were "no open alerts".
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'pr-files': 'src/foo.ts\nsrc/bar.ts',
      'github-token': 'ghp_test',
      repo: 'octo/example',
      'pr-number': '12',
    });

    // The /plans/active fetch returns 500 — `fetchActivePlanFileGlobs`
    // throws and the gate hits `core.setFailed` + early-return before any
    // drift fetch.
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'boom' } }), {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    // GitHub GET + PATCH (the `finally` block still syncs the body).
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { body: '' }));
    let patchBody: string | undefined;
    fetchSpy.mockImplementationOnce(async (_url: string | URL, init?: RequestInit) => {
      patchBody = JSON.parse(String(init?.body)).body as string;
      return jsonResponse(200, {});
    });

    const { run } = await import('../index');
    await run();

    expect(coreMock.setFailed).toHaveBeenCalledWith(expect.stringContaining('semantic gate'));
    expect(patchBody).toBeDefined();
    expect(patchBody!).toContain('<!-- plansync-status -->');
    expect(patchBody!).not.toContain('no open alerts in scope');
    expect(patchBody!).toMatch(/Drift.*not checked/);

    // Sanity: confirm the drift endpoint was never hit.
    const driftCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/drifts?status=open'),
    );
    expect(driftCalls).toHaveLength(0);
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
    // #2754: plan-version fetch (best-effort, before PR-body sync).
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 404 }));
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { body: '' }));
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, {}));

    const { run } = await import('../index');
    await run();

    expect(coreMock.setSecret).toHaveBeenCalledWith('ghp_supersecret_value');
  });
});
