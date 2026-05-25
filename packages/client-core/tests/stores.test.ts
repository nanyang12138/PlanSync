import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  ProjectStore,
  PlanStore,
  TaskStore,
  DriftStore,
  RunStore,
  createStoreRegistry,
} from '../src';
import { MockApiClient } from './mock-api';
import { makeDrift, makePlan, makeProject, makeRun, makeTask } from './fixtures';

describe('Store base FSM', () => {
  it('rejects illegal transitions', async () => {
    const api = new MockApiClient();
    const store = new ProjectStore(api);
    // After load() the store is in `ready` and any direct attempt to
    // skip back to `idle` should throw — guards against a stale
    // refresher clobbering live data.
    api.queue.projectsList = [makeProject()];
    await store.load();
    expect(store.getState().status).toBe('ready');

    // Force-call protected `transition` via a subclass trick: a store
    // that allows arbitrary callers to bypass the FSM is a regression
    // worth catching in tests.
    class Naughty extends ProjectStore {
      bad() {
        // @ts-expect-error — testing private invariant
        this.transition('idle');
      }
    }
    const naughty = new Naughty(api);
    api.queue.projectsList = [];
    await naughty.load();
    expect(() => naughty.bad()).toThrow(InvalidTransitionError);
  });
});

describe('ProjectStore', () => {
  it('load() populates byId + order and emits one subscriber notification', async () => {
    const api = new MockApiClient();
    const store = new ProjectStore(api);
    const p1 = makeProject({ id: 'p-a', name: 'A' });
    const p2 = makeProject({ id: 'p-b', name: 'B' });
    api.queue.projectsList = [p1, p2];

    const seen: string[] = [];
    store.subscribe((s) => seen.push(s.status));

    await store.load();
    const state = store.getState();

    expect(state.status).toBe('ready');
    expect(state.order).toEqual(['p-a', 'p-b']);
    expect(state.byId['p-a'].name).toBe('A');
    expect(state.byId['p-b'].name).toBe('B');
    expect(seen).toEqual(['loading', 'ready']);
  });

  it('load() flips to error on rejection and surfaces the message', async () => {
    const api = new MockApiClient();
    const store = new ProjectStore(api);
    api.queue.projectsList = () => {
      throw new Error('boom');
    };

    await expect(store.load()).rejects.toThrow('boom');
    expect(store.getState().status).toBe('error');
    expect(store.getState().error).toBe('boom');
  });

  it('update() is optimistic and reconciles with the server response', async () => {
    const api = new MockApiClient();
    const store = new ProjectStore(api);
    const existing = makeProject({ id: 'p-a', name: 'Old', phase: 'planning' });
    api.queue.projectsList = [existing];
    await store.load();

    // Server returns the canonical updatedAt.
    const updated = makeProject({
      id: 'p-a',
      name: 'New',
      phase: 'active',
      updatedAt: new Date('2026-06-01T00:00:00Z'),
    });
    api.queue.projectsUpdate = updated;

    const observed: Array<{ name: string; phase: string }> = [];
    store.subscribe((s) => observed.push({ name: s.byId['p-a'].name, phase: s.byId['p-a'].phase }));

    const result = await store.update('p-a', { name: 'New', phase: 'active' });

    expect(result).toEqual(updated);
    // First notification should already show the optimistic patch,
    // last one should match the authoritative server response.
    expect(observed[0]).toEqual({ name: 'New', phase: 'active' });
    expect(store.getState().byId['p-a'].updatedAt).toEqual(updated.updatedAt);
  });

  it('rolls back optimistic updates on server failure', async () => {
    const api = new MockApiClient();
    const store = new ProjectStore(api);
    const existing = makeProject({ id: 'p-a', name: 'Original' });
    api.queue.projectsList = [existing];
    await store.load();

    api.queue.projectsUpdate = () => {
      throw new Error('409 CONFLICT');
    };

    await expect(store.update('p-a', { name: 'Bad' })).rejects.toThrow('409');
    expect(store.getState().byId['p-a'].name).toBe('Original');
    expect(store.getState().status).toBe('error');
    expect(store.getState().error).toBe('409 CONFLICT');
  });
});

describe('PlanStore', () => {
  it('activate() flips the active pointer and supersedes the old plan', async () => {
    const api = new MockApiClient();
    const store = new PlanStore(api);
    const oldActive = makePlan({ id: 'plan-1', version: 1, status: 'active' });
    const proposed = makePlan({ id: 'plan-2', version: 2, status: 'proposed' });
    api.queue.plansList = [oldActive, proposed];
    await store.load('proj_1');

    expect(store.getState().activeId).toBe('plan-1');
    expect(store.getState().proposedId).toBe('plan-2');

    const activated = makePlan({ id: 'plan-2', version: 2, status: 'active' });
    api.queue.plansActivate = activated;
    await store.activate('proj_1', 'plan-2');

    const state = store.getState();
    expect(state.activeId).toBe('plan-2');
    expect(state.proposedId).toBeNull();
    expect(state.byId['plan-1'].status).toBe('superseded');
  });

  it('reacts to plan_activated SSE event without an explicit refresh', async () => {
    const api = new MockApiClient();
    const store = new PlanStore(api);
    api.queue.plansList = [makePlan({ id: 'plan-1', version: 1, status: 'active' })];
    await store.load('proj_1');

    const v2 = makePlan({ id: 'plan-2', version: 2, status: 'active' });
    store.handleEvent({
      eventId: 'evt-1',
      type: 'plan_activated',
      projectId: 'proj_1',
      data: { plan: v2 },
    });

    expect(store.getState().activeId).toBe('plan-2');
    expect(store.getState().byId['plan-2'].status).toBe('active');
  });
});

describe('TaskStore', () => {
  it('handles task_created event by appending to order', async () => {
    const api = new MockApiClient();
    const store = new TaskStore(api);
    api.queue.tasksList = [makeTask({ id: 'task-1', title: 'First' })];
    await store.load('proj_1');

    expect(store.getState().order).toEqual(['task-1']);

    store.handleEvent({
      eventId: 'evt-task-new',
      type: 'task_created',
      projectId: 'proj_1',
      data: { task: makeTask({ id: 'task-2', title: 'Second' }) },
    });

    expect(store.getState().order).toEqual(['task-1', 'task-2']);
    expect(store.getState().byId['task-2'].title).toBe('Second');
  });

  it('handles task_deleted event by dropping from byId and order', async () => {
    const api = new MockApiClient();
    const store = new TaskStore(api);
    api.queue.tasksList = [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })];
    await store.load('proj_1');

    store.handleEvent({
      eventId: 'evt-del',
      type: 'task_deleted',
      projectId: 'proj_1',
      data: { taskId: 'task-1' },
    });

    expect(store.getState().order).toEqual(['task-2']);
    expect(store.getState().byId['task-1']).toBeUndefined();
  });

  it('delete() rolls back when the server rejects', async () => {
    const api = new MockApiClient();
    const store = new TaskStore(api);
    api.queue.tasksList = [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })];
    await store.load('proj_1');

    api.queue.tasksDelete = () => {
      throw new Error('409 STATE_CONFLICT');
    };

    await expect(store.delete('proj_1', 'task-1')).rejects.toThrow('409 STATE_CONFLICT');
    expect(store.getState().order).toEqual(['task-1', 'task-2']);
    expect(store.getState().byId['task-1']).toBeDefined();
  });
});

describe('DriftStore', () => {
  it('load() filters openIds and resolve() removes them optimistically', async () => {
    const api = new MockApiClient();
    const store = new DriftStore(api);
    const openA = makeDrift({ id: 'd-1', status: 'open' });
    const openB = makeDrift({ id: 'd-2', status: 'open' });
    const closed = makeDrift({ id: 'd-3', status: 'resolved' });
    api.queue.driftList = [openA, openB, closed];
    await store.load('proj_1');

    expect(store.getState().openIds.sort()).toEqual(['d-1', 'd-2']);

    api.queue.driftResolve = makeDrift({
      id: 'd-1',
      status: 'resolved',
      resolvedAction: 'rebind',
      resolvedBy: 'alice',
      resolvedAt: new Date(),
    });
    await store.resolve('proj_1', 'd-1', { action: 'rebind' });

    expect(store.getState().openIds).toEqual(['d-2']);
    expect(store.getState().byId['d-1'].status).toBe('resolved');
    expect(store.getState().byId['d-1'].resolvedAction).toBe('rebind');
  });

  it('drift_detected event appends to open list', async () => {
    const api = new MockApiClient();
    const store = new DriftStore(api);
    api.queue.driftList = [];
    await store.load('proj_1');

    expect(store.getState().openIds).toEqual([]);

    store.handleEvent({
      eventId: 'evt-drift',
      type: 'drift_detected',
      projectId: 'proj_1',
      data: { drift: makeDrift({ id: 'd-new' }) },
    });

    expect(store.getState().openIds).toEqual(['d-new']);
  });
});

describe('RunStore', () => {
  it('activeIds tracks non-terminal runs across start/complete cycle', async () => {
    const api = new MockApiClient();
    const store = new RunStore(api);
    api.queue.runsList = [];
    await store.load('proj_1');

    api.queue.runsStart = makeRun({ id: 'run-1', status: 'running' });
    const run = await store.start('proj_1', 'task-1', {
      executorType: 'agent',
      executorName: 'agent-a',
    });
    expect(store.getState().activeIds).toEqual(['run-1']);
    expect(run.status).toBe('running');

    api.queue.runsComplete = makeRun({ id: 'run-1', status: 'completed', endedAt: new Date() });
    await store.complete('proj_1', 'run-1', {
      status: 'completed',
      filesChanged: [],
      blockers: [],
      driftSignals: [],
      deliverablesMet: [],
    });
    expect(store.getState().activeIds).toEqual([]);
    expect(store.getState().byId['run-1'].status).toBe('completed');
  });

  // Closes #785: API publishes 'task_started' (not 'execution_started').
  // The lightweight payload is just {taskId, executorName, executorType}.
  // The store must claim the event so the registry treats it as a hit
  // and the UI can refetch.
  it("handleEvent claims 'task_started' even with the API's lightweight payload (#785, #784)", () => {
    const api = new MockApiClient();
    const store = new RunStore(api);
    const claimed = store.handleEvent({
      eventId: 'evt-1',
      type: 'task_started',
      projectId: 'proj_1',
      data: {
        taskId: 'task-1',
        executorName: 'alice',
        executorType: 'human',
      },
    });
    expect(claimed).toBe(true);
  });

  it("handleEvent merges full ExecutionRun when it's present in the payload (#784)", () => {
    const api = new MockApiClient();
    const store = new RunStore(api);
    const run = makeRun({ id: 'run-evt', status: 'running' });
    const claimed = store.handleEvent({
      eventId: 'evt-2',
      type: 'task_started',
      projectId: 'proj_1',
      data: { run },
    });
    expect(claimed).toBe(true);
    expect(store.getState().byId['run-evt']?.id).toBe('run-evt');
  });
});

// Closes #783: a successful runAction after a previous failure used to
// leave state.status === 'error' because the success path only patched
// `error: undefined`. The retry path now flips status back to 'ready'.
describe('Store.runAction status recovery (#783)', () => {
  it('flips status from error → ready on a successful retry', async () => {
    const api = new MockApiClient();
    const store = new RunStore(api);
    api.queue.runsList = [];
    await store.load('proj_1');
    expect(store.getState().status).toBe('ready');

    // Fail once → status becomes 'error'. Queue a function that throws —
    // the mock's `unwrap` invokes function-typed queue values, so the
    // thrown error propagates back to runAction's catch branch.
    api.queue.runsStart = (() => {
      throw new Error('simulated 5xx');
    }) as unknown as () => ReturnType<typeof makeRun>;
    await expect(
      store.start('proj_1', 'task-1', { executorType: 'agent', executorName: 'a' }),
    ).rejects.toThrow();
    expect(store.getState().status).toBe('error');
    expect(store.getState().error).toBe('simulated 5xx');

    // Retry succeeds → status MUST be back to 'ready' AND error cleared.
    api.queue.runsStart = makeRun({ id: 'run-retry', status: 'running' });
    await store.start('proj_1', 'task-1', { executorType: 'agent', executorName: 'a' });
    expect(store.getState().status).toBe('ready');
    expect(store.getState().error).toBeUndefined();
    expect(store.getState().byId['run-retry']?.status).toBe('running');
  });
});

describe('StoreRegistry', () => {
  it('fans events to every store and deduplicates by eventId', async () => {
    const api = new MockApiClient();
    const registry = createStoreRegistry(api);
    api.queue.projectsList = [makeProject({ id: 'proj_1' })];
    api.queue.tasksList = [makeTask({ id: 'task-1' })];

    await registry.projects.load();
    await registry.tasks.load('proj_1');

    const newTask = makeTask({ id: 'task-2', title: 'Fresh' });
    const event = {
      eventId: 'evt-shared',
      type: 'task_created' as const,
      projectId: 'proj_1',
      data: { task: newTask },
    };

    registry.handleEvent(event);
    registry.handleEvent(event);
    registry.handleEvent(event);

    expect(registry.tasks.getState().order).toEqual(['task-1', 'task-2']);
    expect(registry.tasks.getState().byId['task-2'].title).toBe('Fresh');
  });

  it('connect() wires the SSE transport when supported', () => {
    const api = new MockApiClient();
    const registry = createStoreRegistry(api);
    const unsubscribe = registry.connect({ projectId: 'proj_1' });

    expect(api.subscriberCount).toBe(1);

    // A cross-project event should be filtered by the mock transport.
    api.emit({
      eventId: 'evt-other',
      type: 'task_created',
      projectId: 'proj_other',
      data: { task: makeTask({ id: 'task-other' }) },
    });
    expect(registry.tasks.getState().byId['task-other']).toBeUndefined();

    // A scoped event should reach the store.
    api.emit({
      eventId: 'evt-mine',
      type: 'task_created',
      projectId: 'proj_1',
      data: { task: makeTask({ id: 'task-mine' }) },
    });
    expect(registry.tasks.getState().byId['task-mine']).toBeDefined();

    unsubscribe();
    expect(api.subscriberCount).toBe(0);
  });
});

// R5 (closes #918 #939 #954 #940) — RunStore lightweight-event refetch
// + stale-action guard.
describe('R5: RunStore lightweight task_started triggers refetch', () => {
  it('schedules api.runs.list when task_started arrives without a full run', async () => {
    const api = new MockApiClient();
    const store = new RunStore(api);
    api.queue.runsList = [];
    await store.load('proj_1');

    api.calls.runs.list.length = 0;
    api.queue.runsList = [makeRun({ id: 'run-evt', status: 'running' })];

    const claimed = store.handleEvent({
      eventId: 'evt-light',
      type: 'task_started',
      projectId: 'proj_1',
      data: { taskId: 'task-1', executorName: 'a', executorType: 'agent' },
    });
    expect(claimed).toBe(true);
    // Wait one microtask + immediate for the void-load() to settle.
    await new Promise((r) => setImmediate(r));
    expect(api.calls.runs.list.length).toBeGreaterThan(0);
    expect(store.getState().byId['run-evt']?.status).toBe('running');
  });
});

describe('R5: runAction stale-success guard (#940)', () => {
  it('does NOT overwrite a newer error with a late-arriving stale success', async () => {
    const api = new MockApiClient();
    const store = new RunStore(api);
    api.queue.runsList = [];
    await store.load('proj_1');

    // Action A: slow success that resolves AFTER B's failure.
    let resolveA: (r: ReturnType<typeof makeRun>) => void = () => {};
    const slowA = new Promise<ReturnType<typeof makeRun>>((res) => {
      resolveA = res;
    });
    api.queue.runsStart = (() => slowA) as unknown as () => ReturnType<typeof makeRun>;
    const aPromise = store
      .start('proj_1', 'task-1', { executorType: 'agent', executorName: 'a' })
      .catch(() => undefined);

    // Wait for A to be in-flight.
    await new Promise((r) => setImmediate(r));

    // Action B: synchronous failure → status='error'.
    api.queue.runsStart = (() => {
      throw new Error('B failed');
    }) as unknown as () => ReturnType<typeof makeRun>;
    await expect(
      store.start('proj_1', 'task-1', { executorType: 'agent', executorName: 'b' }),
    ).rejects.toThrow('B failed');
    expect(store.getState().status).toBe('error');
    expect(store.getState().error).toBe('B failed');

    // Now resolve A. Pre-fix this would flip status back to 'ready' and
    // clear the error; post-fix the stale-seq check skips the success
    // patch entirely, so B's error wins.
    resolveA(makeRun({ id: 'run-A', status: 'running' }));
    await aPromise;

    expect(store.getState().status).toBe('error');
    expect(store.getState().error).toBe('B failed');
  });
});

// R5b / closes #996 — stale-failure must still invoke onFailure so
// the caller's rollback runs. Pre-fix, a stale failure just `throw`'d,
// leaving its optimistic delta in state indefinitely. Probe via a
// custom store with explicit optimistic + onFailure + a slow action,
// rather than relying on TaskStore semantics that may evolve.
describe('R5b: stale-failure invokes onFailure rollback (#996)', () => {
  it('runs onFailure even when the failed action was superseded by a newer one', async () => {
    interface ProbeState {
      status: 'idle' | 'loading' | 'ready' | 'error';
      error?: string;
      tag: string[];
    }
    class ProbeStore extends ProjectStore {
      // ProbeStore reuses ProjectStore for boilerplate but exposes a
      // public `runProbe(...)` so the test can drive runAction directly.
      async runProbe(args: {
        action: () => Promise<string>;
        optimistic: (s: unknown) => unknown;
        onSuccess?: (s: unknown, r: string) => unknown;
        onFailure: (s: unknown, e: Error) => unknown;
      }): Promise<string> {
        // @ts-expect-error — testing protected runAction
        return this.runAction({
          action: args.action,
          optimistic: args.optimistic,
          onSuccess: args.onSuccess ?? ((s) => s),
          onFailure: args.onFailure,
        });
      }
    }

    const api = new MockApiClient();
    const store = new ProbeStore(api);
    api.queue.projectsList = [];
    await store.load();

    let onFailureCalled = false;

    // Action A: slow + will fail after B starts.
    let rejectA: (err: Error) => void = () => {};
    const slowA = new Promise<string>((_, rej) => {
      rejectA = rej;
    });
    const aPromise = store
      .runProbe({
        action: () => slowA,
        optimistic: (s) => ({ ...(s as object) }),
        onFailure: (s, _e) => {
          onFailureCalled = true;
          return s;
        },
      })
      .catch(() => undefined);

    // Yield so A's optimistic + scheduling lands.
    await new Promise((r) => setImmediate(r));

    // Action B: synchronous success bumps latestActionSeq above A's.
    await store.runProbe({
      action: async () => 'B',
      optimistic: (s) => s,
      onFailure: (s) => s,
    });

    // Now A fails — stale.
    rejectA(new Error('A failed late'));
    await aPromise;

    expect(onFailureCalled).toBe(true);
  });
});
