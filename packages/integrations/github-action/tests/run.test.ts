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

describe('github-action run()', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.values(coreMock).forEach((fn) => fn.mockReset());
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('masks the api-key via core.setSecret immediately after reading inputs', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_supersecret_value_42',
      project: 'proj-123',
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const { run } = await import('../index');
    await run();

    expect(coreMock.setSecret).toHaveBeenCalledTimes(1);
    expect(coreMock.setSecret).toHaveBeenCalledWith('ps_key_supersecret_value_42');

    // setSecret must be called before any HTTP request (so the masking is
    // active before the value could leak into a downstream log).
    const setSecretOrder = coreMock.setSecret.mock.invocationCallOrder[0];
    const fetchOrder = fetchSpy.mock.invocationCallOrder[0];
    expect(setSecretOrder).toBeLessThan(fetchOrder);
  });

  it('does not call core.setSecret when api-key input is empty', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': '',
      project: 'proj-123',
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse(401, { error: { message: 'unauthorized' } }));

    const { run } = await import('../index');
    await run();

    expect(coreMock.setSecret).not.toHaveBeenCalled();
    expect(coreMock.setFailed).toHaveBeenCalledWith('unauthorized');
  });

  it('warns and gates on all project drifts when neither task-ids nor branch-name is provided', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
    });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            id: 'd1',
            taskId: 't1',
            severity: 'high',
            taskBoundVersion: 1,
            currentPlanVersion: 2,
          },
        ],
      }),
    );

    const { run } = await import('../index');
    await run();

    // Surface the project-wide warning so users understand the gate is broad.
    const warnings = coreMock.warning.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes('project-wide mode'))).toBe(true);
    expect(coreMock.setFailed).toHaveBeenCalledWith('High severity drift detected');
    expect(coreMock.setOutput).toHaveBeenCalledWith('drift-count', '1');
    expect(coreMock.setOutput).toHaveBeenCalledWith('has-drift', 'true');
  });

  it('R-094: only gates on drifts whose taskId is in the explicit task-ids input', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'task-ids': ' t1 , t2 ',
    });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            id: 'd-out',
            taskId: 't-other',
            severity: 'high',
            taskBoundVersion: 1,
            currentPlanVersion: 2,
            task: { title: 'Unrelated PR task' },
          },
          {
            id: 'd-in',
            taskId: 't2',
            severity: 'medium',
            taskBoundVersion: 1,
            currentPlanVersion: 2,
            task: { title: 'My PR task' },
          },
        ],
      }),
    );

    const { run } = await import('../index');
    await run();

    // The out-of-scope HIGH drift must NOT fail the build.
    expect(coreMock.setFailed).not.toHaveBeenCalled();
    // Only the in-scope MEDIUM drift counts.
    expect(coreMock.setOutput).toHaveBeenCalledWith('drift-count', '1');
    expect(coreMock.setOutput).toHaveBeenCalledWith('has-drift', 'true');

    const infos = coreMock.info.mock.calls.map((c) => String(c[0]));
    expect(infos.some((m) => m.includes('Scoping drift check to 2 explicit task id(s)'))).toBe(
      true,
    );
    expect(infos.some((m) => m.includes('Ignored 1 open drift'))).toBe(true);

    // The project-wide warning should NOT be emitted in scoped mode.
    const warnings = coreMock.warning.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes('project-wide mode'))).toBe(false);
  });

  it('R-094: branch-name input fetches tasks and scopes drifts to those with matching branchName', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'branch-name': 'feat/foo',
    });

    // First HTTP call: GET /tasks?page=1 — returns a page smaller than pageSize
    // so the loop stops after one fetch.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { id: 't-match-1', branchName: 'feat/foo' },
          { id: 't-other', branchName: 'feat/bar' },
          { id: 't-null', branchName: null },
        ],
      }),
    );

    // Second HTTP call: GET /drifts — return one drift in scope (HIGH) and
    // one drift on an unrelated branch (HIGH). Only the in-scope one should
    // gate the build.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            id: 'd-out',
            taskId: 't-other',
            severity: 'high',
            taskBoundVersion: 1,
            currentPlanVersion: 2,
          },
          {
            id: 'd-in',
            taskId: 't-match-1',
            severity: 'high',
            taskBoundVersion: 1,
            currentPlanVersion: 2,
          },
        ],
      }),
    );

    const { run } = await import('../index');
    await run();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/tasks?page=1');
    expect(String(fetchSpy.mock.calls[1][0])).toContain('/drifts?status=open');

    expect(coreMock.setOutput).toHaveBeenCalledWith('drift-count', '1');
    expect(coreMock.setFailed).toHaveBeenCalledWith('High severity drift detected');

    const infos = coreMock.info.mock.calls.map((c) => String(c[0]));
    expect(
      infos.some((m) => m.includes('Scoping drift check to 1 task(s) on branch "feat/foo"')),
    ).toBe(true);
  });

  it('R-094: scoped mode with no in-scope drifts passes the gate even when other open drifts exist', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'task-ids': 't-mine',
    });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            id: 'd-out',
            taskId: 't-other',
            severity: 'high',
            taskBoundVersion: 1,
            currentPlanVersion: 2,
          },
        ],
      }),
    );

    const { run } = await import('../index');
    await run();

    expect(coreMock.setFailed).not.toHaveBeenCalled();
    expect(coreMock.setOutput).toHaveBeenCalledWith('drift-count', '0');
    expect(coreMock.setOutput).toHaveBeenCalledWith('has-drift', 'false');
  });

  // ---- #146 — drifts must paginate; a HIGH drift on page 2 must still gate ----
  it('#146: paginates /drifts and surfaces HIGH severity entries on later pages', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'task-ids': 't-target',
    });
    // Page 1: full page of unrelated drifts (forces the loop to fetch page 2).
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `d-page1-${i}`,
      taskId: `t-other-${i}`,
      severity: 'low',
      taskBoundVersion: 1,
      currentPlanVersion: 2,
    }));
    // Page 2: contains the in-scope HIGH drift.
    const page2 = [
      {
        id: 'd-target',
        taskId: 't-target',
        severity: 'high',
        taskBoundVersion: 1,
        currentPlanVersion: 2,
      },
    ];
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: page1 }));
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: page2 }));

    const { run } = await import('../index');
    await run();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/drifts\?status=open&page=1/);
    expect(String(fetchSpy.mock.calls[1][0])).toMatch(/\/drifts\?status=open&page=2/);
    expect(coreMock.setFailed).toHaveBeenCalledWith('High severity drift detected');
    expect(coreMock.setOutput).toHaveBeenCalledWith('drift-count', '1');
  });

  // ---- #147 — whitespace branch-name must not silently pass the gate ----
  it('#147: whitespace branch-name falls back to project-wide warning, not silent pass', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'branch-name': '   ',
    });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            id: 'd-high',
            taskId: 't-something',
            severity: 'high',
            taskBoundVersion: 1,
            currentPlanVersion: 2,
          },
        ],
      }),
    );

    const { run } = await import('../index');
    await run();

    // Whitespace input must not be treated as a real branch — it must NOT
    // fetch /tasks (which is what the previous bug did before failing the
    // build silently).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/drifts\?status=open/);

    const warnings = coreMock.warning.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes('project-wide mode'))).toBe(true);
    // The HIGH drift is still gated — we did not silently pass.
    expect(coreMock.setFailed).toHaveBeenCalledWith('High severity drift detected');
  });

  // ---- #147 — explicit branch with zero matching tasks must fail loudly ----
  it('#147: explicit branch-name with 0 matching tasks fails the build loudly', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'branch-name': 'feat/typo',
    });
    // /tasks page 1 returns 0 tasks → no scoped IDs.
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const { run } = await import('../index');
    await run();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const failed = String(coreMock.setFailed.mock.calls[0]?.[0] ?? '');
    expect(failed).toMatch(/no tasks found with branchName="feat\/typo"/);
  });

  // ---- #148 — task pagination cap must surface, not silently truncate ----
  it('#148: task pagination cap fails the build instead of returning a partial scope', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'branch-name': 'feat/big-project',
    });
    // Always return a full page (without pagination metadata) so the loop
    // exhausts the cap. Legacy server simulation.
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: `t-${i}`,
      branchName: 'feat/other',
    }));
    for (let i = 0; i < 50; i += 1) {
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: fullPage }));
    }

    const { run } = await import('../index');
    await run();

    // 50 task fetches happened, then the action bailed out — no /drifts call.
    expect(fetchSpy).toHaveBeenCalledTimes(50);
    expect(fetchSpy.mock.calls.every((c) => String(c[0]).includes('/tasks?page='))).toBe(true);

    const failed = String(coreMock.setFailed.mock.calls[0]?.[0] ?? '');
    expect(failed).toMatch(/scope would be incomplete/);
  });

  // ---- #187 / #217 — exact pageSize-multiple totals must NOT report truncated ----

  it('#187/#217: branch task list of exactly TASK_PAGE_SIZE×N rows is not falsely truncated', async () => {
    // Server is a real PlanSync API: returns pagination.totalPages so the
    // action can trust it instead of relying on the partial-page heuristic.
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'branch-name': 'feat/exact',
    });
    const TOTAL_PAGES = 3;
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: `t-${i}`,
      branchName: 'feat/other',
    }));
    // Pages 1..3, all exactly full, with totalPages: 3 → action must stop
    // after page 3 and report scope complete (no setFailed).
    for (let p = 1; p <= TOTAL_PAGES; p += 1) {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(200, {
          data: fullPage,
          pagination: { page: p, pageSize: 100, total: TOTAL_PAGES * 100, totalPages: TOTAL_PAGES },
        }),
      );
    }
    // /drifts call (irrelevant — branch matched 0 tasks → setFailed will
    // come from the "no tasks found" branch, but we want to confirm we did
    // NOT hit the truncation branch).
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [],
        pagination: { page: 1, pageSize: 100, total: 0, totalPages: 0 },
      }),
    );

    const { run } = await import('../index');
    await run();

    // Only TOTAL_PAGES task fetches happened — no walk to the cap.
    const taskCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/tasks?page='));
    expect(taskCalls).toHaveLength(TOTAL_PAGES);

    const failed = String(coreMock.setFailed.mock.calls[0]?.[0] ?? '');
    expect(failed).not.toMatch(/scope would be incomplete/);
    // The "no tasks found" branch fires because no row matches `feat/exact`.
    expect(failed).toMatch(/no tasks found with branchName="feat\/exact"/);
  });

  it('#187/#217: drift list of exactly DRIFT_PAGE_SIZE×N rows is not falsely truncated', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
    });
    // No scoping → goes straight to /drifts. Two full pages with totalPages: 2.
    const fullDriftPage = Array.from({ length: 100 }, (_, i) => ({
      id: `d-${i}`,
      taskId: `t-${i}`,
      severity: 'low',
      taskBoundVersion: 1,
      currentPlanVersion: 2,
    }));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: fullDriftPage,
        pagination: { page: 1, pageSize: 100, total: 200, totalPages: 2 },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: fullDriftPage,
        pagination: { page: 2, pageSize: 100, total: 200, totalPages: 2 },
      }),
    );

    const { run } = await import('../index');
    await run();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const failed = String(coreMock.setFailed.mock.calls[0]?.[0] ?? '');
    expect(failed).not.toMatch(/refusing to gate on a partial view/);
    // 200 LOW drifts → no setFailed (only HIGH triggers fail).
    expect(coreMock.setOutput).toHaveBeenCalledWith('drift-count', '200');
  });

  // ---- #189 — drift cap should fail the build instead of silently truncating ----

  it('#189: drift list exceeding DRIFT_PAGE_CAP fails the build (covers the cap branch)', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
    });
    // Legacy server simulation: every page is full, no pagination block.
    // Exactly DRIFT_PAGE_CAP (50) responses queued — action must hit the
    // truncation branch and setFailed.
    const fullDriftPage = Array.from({ length: 100 }, (_, i) => ({
      id: `d-${i}`,
      taskId: `t-${i}`,
      severity: 'low',
      taskBoundVersion: 1,
      currentPlanVersion: 2,
    }));
    for (let i = 0; i < 50; i += 1) {
      fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: fullDriftPage }));
    }

    const { run } = await import('../index');
    await run();

    expect(fetchSpy).toHaveBeenCalledTimes(50);
    const failed = String(coreMock.setFailed.mock.calls[0]?.[0] ?? '');
    expect(failed).toMatch(/refusing to gate on a partial view/);
  });
});
