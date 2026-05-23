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
