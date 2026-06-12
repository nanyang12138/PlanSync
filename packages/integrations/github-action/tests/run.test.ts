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

  it('R-094/R-207: branch-name uses the server-side filter and scopes drifts to the returned task(s)', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'branch-name': 'feat/foo',
    });

    // First HTTP call: GET /tasks?branchName=feat/foo — the SERVER now filters,
    // so it returns only the matching task(s). The action no longer matches
    // client-side; it scopes to whatever the filtered query returns.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [{ id: 't-match-1', branchName: 'feat/foo', boundPlanVersion: 2 }],
        pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
      }),
    );

    // Second HTTP call: GET /drifts — one in-scope HIGH drift, one out-of-scope.
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
    // R-207: the request now carries the server-side branchName filter.
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/tasks?branchName=feat%2Ffoo');
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
    expect(fetchSpy.mock.calls.every((c) => String(c[0]).includes('/tasks?branchName='))).toBe(
      true,
    );

    const failed = String(coreMock.setFailed.mock.calls[0]?.[0] ?? '');
    expect(failed).toMatch(/scope would be incomplete/);
  });

  // ---- #187 / #217 — exact pageSize-multiple totals must NOT report truncated ----

  it('#187/#217: server-filtered branch task list of exactly TASK_PAGE_SIZE×N rows is not falsely truncated', async () => {
    // Server is a real PlanSync API: returns pagination.totalPages so the
    // action can trust it instead of relying on the partial-page heuristic.
    // R-207: the server now filters by branchName, so every returned row is a
    // genuine match — the action scopes to all of them.
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'branch-name': 'feat/exact',
    });
    const TOTAL_PAGES = 3;
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: `t-${i}`,
      branchName: 'feat/exact',
    }));
    // Pages 1..3, all exactly full, with totalPages: 3 → action must stop
    // after page 3 and report scope complete (no truncation setFailed).
    for (let p = 1; p <= TOTAL_PAGES; p += 1) {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(200, {
          data: fullPage,
          pagination: { page: p, pageSize: 100, total: TOTAL_PAGES * 100, totalPages: TOTAL_PAGES },
        }),
      );
    }
    // /drifts: empty → the gate passes (scope is 300 tasks, no open drift).
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [],
        pagination: { page: 1, pageSize: 100, total: 0, totalPages: 0 },
      }),
    );

    const { run } = await import('../index');
    await run();

    // Only TOTAL_PAGES task fetches happened — no walk to the cap.
    const taskCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/tasks?branchName='),
    );
    expect(taskCalls).toHaveLength(TOTAL_PAGES);

    // Did NOT falsely truncate, and did NOT hit "no tasks found" — it scoped to
    // the 300 returned tasks and proceeded to the (empty) drift check.
    expect(coreMock.setFailed).not.toHaveBeenCalled();
    expect(coreMock.setOutput).toHaveBeenCalledWith('drift-count', '0');
    expect(coreMock.setOutput).toHaveBeenCalledWith('has-drift', 'false');
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

  // ---- R-157 — semantic deliverable gate ----

  it('R-157: fails the build when PR files do not match any active deliverable glob', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'pr-files': 'docs/random.md\npackages/foo/unrelated.ts',
    });
    // GET /plans/active
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: 'plan-1', version: 3 } }));
    // GET /plans/plan-1/deliverables
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            id: 'd-1',
            slug: 'api-routes',
            refType: 'file_glob',
            refUri: 'packages/api/src/**/*.ts',
            status: 'active',
          },
          {
            id: 'd-2',
            slug: 'free-text',
            refType: 'free',
            refUri: null,
            status: 'active',
          },
        ],
      }),
    );

    const { run } = await import('../index');
    await run();

    // Only the two semantic-gate fetches happened — drift check was
    // short-circuited because the gate already failed.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/plans/active');
    expect(String(fetchSpy.mock.calls[1][0])).toContain('/deliverables');

    const failed = String(coreMock.setFailed.mock.calls[0]?.[0] ?? '');
    expect(failed).toMatch(/Modified files are not in scope/);
    expect(failed).toMatch(/2 unmatched/);

    expect(coreMock.setOutput).toHaveBeenCalledWith('semantic-gate', 'failed');
    expect(coreMock.setOutput).toHaveBeenCalledWith(
      'unmatched-files',
      'docs/random.md\npackages/foo/unrelated.ts',
    );
    // R-157 short-circuit clears drift outputs so downstream summaries do
    // not double-report a confusing "no drift, looks good" alongside the
    // semantic-gate failure.
    expect(coreMock.setOutput).toHaveBeenCalledWith('drift-count', '0');
    expect(coreMock.setOutput).toHaveBeenCalledWith('has-drift', 'false');
  });

  it('R-157: passes the semantic gate and falls through to the drift check when every PR file matches a glob', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'pr-files': 'packages/api/src/lib/foo.ts,packages/api/src/app/bar.ts',
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: 'plan-1', version: 3 } }));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            id: 'd-1',
            slug: 'api-routes',
            refType: 'file_glob',
            refUri: 'packages/api/src/**/*.ts',
            status: 'active',
          },
          // A deprecated glob must NOT count even if its pattern would match.
          // Otherwise retired deliverables would silently keep gating PRs.
          {
            id: 'd-2',
            slug: 'old',
            refType: 'file_glob',
            refUri: 'packages/api/src/**/*.ts',
            status: 'deprecated',
          },
        ],
      }),
    );
    // Drift check fetches /drifts and returns empty.
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const { run } = await import('../index');
    await run();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(String(fetchSpy.mock.calls[2][0])).toContain('/drifts?status=open');
    expect(coreMock.setOutput).toHaveBeenCalledWith('semantic-gate', 'passed');
    expect(coreMock.setOutput).toHaveBeenCalledWith('drift-count', '0');
    expect(coreMock.setOutput).toHaveBeenCalledWith('has-drift', 'false');
    expect(coreMock.setFailed).not.toHaveBeenCalled();
  });

  it('R-157: legacy-mode=true skips the semantic gate entirely', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'pr-files': 'completely/unrelated.txt',
      'legacy-mode': 'true',
    });
    // Only the drift check should fire — no /plans/active call.
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const { run } = await import('../index');
    await run();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/drifts?status=open');
    expect(coreMock.setOutput).toHaveBeenCalledWith('semantic-gate', 'skipped');
    expect(coreMock.setFailed).not.toHaveBeenCalled();
  });

  it('R-157: skips the semantic gate when the active plan has zero file_glob deliverables', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'pr-files': 'anywhere.txt',
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: 'plan-1', version: 1 } }));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [{ id: 'd-1', slug: 'free', refType: 'free', refUri: null, status: 'active' }],
      }),
    );
    // Drift check still runs.
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const { run } = await import('../index');
    await run();

    expect(coreMock.setOutput).toHaveBeenCalledWith('semantic-gate', 'skipped');
    const infos = coreMock.info.mock.calls.map((c) => String(c[0]));
    expect(infos.some((m) => m.includes('no `file_glob` deliverables'))).toBe(true);
    expect(coreMock.setFailed).not.toHaveBeenCalled();
  });

  it('R-157: skips the semantic gate when there is no active plan (404)', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'pr-files': 'anywhere.txt',
    });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(404, { error: { message: 'No active plan found' } }),
    );
    // Drift check still runs.
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const { run } = await import('../index');
    await run();

    expect(coreMock.setOutput).toHaveBeenCalledWith('semantic-gate', 'skipped');
    const infos = coreMock.info.mock.calls.map((c) => String(c[0]));
    expect(infos.some((m) => m.includes('no active plan'))).toBe(true);
    expect(coreMock.setFailed).not.toHaveBeenCalled();
  });

  // ---- #1266 — parsePrFiles should split space-separated input ----

  it('#1266: parses space-separated pr-files (tj-actions/changed-files default output)', async () => {
    // `tj-actions/changed-files` emits `all_changed_files` space-separated
    // by default. Before #1266 the parser collapsed the whole string into
    // a single "filename" that could never match a glob, producing a
    // false-positive semantic-gate failure.
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'pr-files': 'packages/api/src/lib/foo.ts packages/api/src/app/bar.ts',
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: 'plan-1', version: 3 } }));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            id: 'd-1',
            slug: 'api-routes',
            refType: 'file_glob',
            refUri: 'packages/api/src/**/*.ts',
            status: 'active',
          },
        ],
      }),
    );
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const { run } = await import('../index');
    await run();

    expect(coreMock.setOutput).toHaveBeenCalledWith('semantic-gate', 'passed');
    expect(coreMock.setFailed).not.toHaveBeenCalled();
    const infos = coreMock.info.mock.calls.map((c) => String(c[0]));
    expect(infos.some((m) => m.includes('all 2 PR file(s) match'))).toBe(true);
  });

  it('#1266: space-separated input still flags genuinely out-of-scope files individually', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'pr-files': 'packages/api/src/lib/foo.ts docs/random.md',
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: 'plan-1', version: 3 } }));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            id: 'd-1',
            slug: 'api-routes',
            refType: 'file_glob',
            refUri: 'packages/api/src/**/*.ts',
            status: 'active',
          },
        ],
      }),
    );

    const { run } = await import('../index');
    await run();

    expect(coreMock.setOutput).toHaveBeenCalledWith('semantic-gate', 'failed');
    expect(coreMock.setOutput).toHaveBeenCalledWith('unmatched-files', 'docs/random.md');
    const failed = String(coreMock.setFailed.mock.calls[0]?.[0] ?? '');
    expect(failed).toMatch(/1 unmatched/);
  });

  it('#1266: newline-separated input still preserves filenames containing spaces', async () => {
    // Regression guard for the original deliberate behaviour: when the
    // caller uses a structured delimiter (newline or comma), embedded
    // spaces are part of the filename and must NOT be split apart.
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'pr-files': 'docs/my notes/foo.md\ndocs/bar.md',
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: 'plan-1', version: 3 } }));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            id: 'd-1',
            slug: 'docs',
            refType: 'file_glob',
            refUri: 'docs/**/*.md',
            status: 'active',
          },
        ],
      }),
    );
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const { run } = await import('../index');
    await run();

    expect(coreMock.setOutput).toHaveBeenCalledWith('semantic-gate', 'passed');
    expect(coreMock.setFailed).not.toHaveBeenCalled();
    const infos = coreMock.info.mock.calls.map((c) => String(c[0]));
    // Both files (including the one with the embedded space) counted.
    expect(infos.some((m) => m.includes('all 2 PR file(s) match'))).toBe(true);
  });

  it('R-157: skips the semantic gate when pr-files input is empty', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      // pr-files intentionally omitted
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const { run } = await import('../index');
    await run();

    // No /plans/active call → semantic gate skipped, drift check ran.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/drifts?status=open');
    expect(coreMock.setOutput).toHaveBeenCalledWith('semantic-gate', 'skipped');
  });

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

  // ---- R-207 / L3 — strict-sourcing + exemption ----

  it('R-207: strict-sourcing refuses an unscoped (project-wide) PR', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'strict-sourcing': 'true',
      // no branch-name, no task-ids, no pr-files
    });

    const { run } = await import('../index');
    await run();

    // Refused before any drift query — nothing to fetch.
    expect(fetchSpy).not.toHaveBeenCalled();
    const failed = String(coreMock.setFailed.mock.calls[0]?.[0] ?? '');
    expect(failed).toMatch(/not scoped to any task/);
  });

  it('R-207: strict-sourcing fails when a scoped task is bound to a stale plan version', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'branch-name': 'feat/stale',
      'strict-sourcing': 'true',
    });
    // GET /tasks?branchName=feat/stale → task bound to v1.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [{ id: 't-stale', branchName: 'feat/stale', boundPlanVersion: 1 }],
        pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
      }),
    );
    // GET /plans/active → active is v2.
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: 'plan-1', version: 2 } }));

    const { run } = await import('../index');
    await run();

    // Bailed at the version check — never reached /drifts.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const failed = String(coreMock.setFailed.mock.calls[0]?.[0] ?? '');
    expect(failed).toMatch(/stale plan version/);
    const errors = coreMock.error.mock.calls.map((c) => String(c[0]));
    expect(
      errors.some((e) => e.includes('bound to plan v1') && e.includes('active plan is v2')),
    ).toBe(true);
  });

  it('R-207: strict-sourcing passes when the scoped task is on the active plan version', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'branch-name': 'feat/ok',
      'strict-sourcing': 'true',
    });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [{ id: 't-ok', branchName: 'feat/ok', boundPlanVersion: 2 }],
        pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
      }),
    );
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: 'plan-1', version: 2 } }));
    // /drifts → empty, gate passes.
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const { run } = await import('../index');
    await run();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(coreMock.setFailed).not.toHaveBeenCalled();
    expect(coreMock.setOutput).toHaveBeenCalledWith('drift-count', '0');
  });

  it('R-207: an exempt label skips the gate entirely (even with strict-sourcing on)', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'strict-sourcing': 'true',
      'exempt-labels': 'plansync:exempt',
      'github-token': 'ghs_token',
      repo: 'acme/widgets',
      'pr-number': '42',
    });
    // Catch-all: satisfies both the label read (.labels) and the R-193 PR-body
    // GET/PATCH (.body) in the finally block.
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { labels: [{ name: 'plansync:exempt' }], body: '' }),
    );

    const { run } = await import('../index');
    await run();

    const warnings = coreMock.warning.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes('EXEMPTED via label "plansync:exempt"'))).toBe(true);
    expect(coreMock.setFailed).not.toHaveBeenCalled();
    expect(coreMock.setOutput).toHaveBeenCalledWith('drift-count', '0');
    expect(coreMock.setOutput).toHaveBeenCalledWith('has-drift', 'false');
  });

  it('R-207: exempt-labels set without the github-token trio fails closed (gate still runs)', async () => {
    configureInputs({
      'api-url': 'https://plansync.example.com',
      'api-key': 'ps_key_test',
      project: 'proj-123',
      'exempt-labels': 'plansync:exempt',
      // no github-token/repo/pr-number → exemption unavailable
      'task-ids': 't1',
    });
    // Gate runs: /drifts returns empty → passes, but the fail-closed warning fired.
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    const { run } = await import('../index');
    await run();

    const warnings = coreMock.warning.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes('exemption is unavailable'))).toBe(true);
    // It did NOT skip — it ran the drift query.
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/drifts?status=open');
  });
});
