import type { ExecutionRun, CreateExecutionRun, CompleteExecutionRun } from '@plansync/shared';
import type { ApiClient } from '../api-client';
import type { DomainEvent } from '../events';
import { Store, type BaseState } from '../store-base';

export interface RunState extends BaseState {
  byId: Record<string, ExecutionRun>;
  /** Run ids that are not yet in a terminal state. */
  activeIds: string[];
  loadedProjectId: string | null;
}

const TERMINAL: ReadonlySet<ExecutionRun['status']> = new Set([
  'completed',
  'failed',
  'cancelled',
  'stale',
  'superseded',
]);

const initial: RunState = {
  status: 'idle',
  byId: {},
  activeIds: [],
  loadedProjectId: null,
};

function recomputeActive(byId: Record<string, ExecutionRun>): string[] {
  return Object.values(byId)
    .filter((r) => !TERMINAL.has(r.status))
    .sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt))
    .map((r) => r.id);
}

export class RunStore extends Store<RunState> {
  constructor(private readonly api: ApiClient) {
    super(initial);
  }

  async load(projectId: string, taskId?: string): Promise<ExecutionRun[]> {
    this.transition('loading');
    try {
      const runs = await this.api.runs.list(projectId, taskId);
      const freshById = Object.fromEntries(runs.map((r) => [r.id, r]));
      this.transition('ready', (state) => {
        // Task-scoped loads return only the requested task's runs, so a
        // blind replace would evict every other task's runs already in
        // the store (#995). Merge in that case — but ONLY when we're
        // still on the same project. If `projectId` changed, the
        // previous `state.byId` belongs to a different project and
        // must be discarded; otherwise project A's runs would leak
        // into project B's state (#2823). Project-scoped loads
        // (`taskId` omitted) are authoritative and always replace.
        const sameProject = state.loadedProjectId === projectId;
        const byId = taskId && sameProject ? { ...state.byId, ...freshById } : freshById;
        return {
          ...state,
          loadedProjectId: projectId,
          byId,
          activeIds: recomputeActive(byId),
        };
      });
      return runs;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.transition('error', (state) => ({ ...state, error: error.message }));
      throw error;
    }
  }

  async start(projectId: string, taskId: string, body: CreateExecutionRun): Promise<ExecutionRun> {
    return this.runAction({
      action: () => this.api.runs.start(projectId, taskId, body),
      onSuccess: (state, run) => {
        const byId = { ...state.byId, [run.id]: run };
        return { ...state, byId, activeIds: recomputeActive(byId) };
      },
    });
  }

  async complete(
    projectId: string,
    runId: string,
    body: CompleteExecutionRun,
  ): Promise<ExecutionRun> {
    return this.runAction({
      action: () => this.api.runs.complete(projectId, runId, body),
      onSuccess: (state, run) => {
        const byId = { ...state.byId, [run.id]: run };
        return { ...state, byId, activeIds: recomputeActive(byId) };
      },
    });
  }

  handleEvent(event: DomainEvent): boolean {
    // Closes #785 — the API publishes 'task_started' (lightweight payload
    // {taskId, executorName, executorType}); the previous version of
    // RunStore listened for 'execution_started' which the server never
    // emits, so a remote run never appeared in the local store. The
    // other three events ('execution_stale' / 'execution_failed' /
    // 'execution_superseded') are emitted by the heartbeat scanner and
    // also carry only run/task ids — not full run objects.
    const STORE_AFFECTING_EVENTS: ReadonlySet<string> = new Set([
      'task_started',
      'execution_stale',
      'execution_failed',
      'execution_superseded',
    ]);
    if (!STORE_AFFECTING_EVENTS.has(event.type)) return false;

    // Closes #784 — when a full ExecutionRun is on the payload (legacy
    // or future opt-in publishers), merge it directly. No refetch needed.
    const run = (event.data as { run?: unknown } | undefined)?.run as ExecutionRun | undefined;
    if (run && typeof run === 'object' && typeof run.id === 'string') {
      this.setState((state) => {
        const byId = { ...state.byId, [run.id]: run };
        return { ...state, byId, activeIds: recomputeActive(byId) };
      });
      return true;
    }

    // Closes #918 / #939 / #954 (R5 review feedback): the lightweight
    // payload doesn't carry the run object. Returning `true` alone is
    // not enough — `StoreRegistry` discards the return value, so the
    // UI never learns there was a change. Schedule a fire-and-forget
    // refetch against the API so the new run actually shows up in the
    // store. We can only refetch if we know which project we already
    // loaded; if `loadedProjectId` is null (store hasn't been loaded
    // yet) we still claim the event (a future load() will see the
    // server-side state) but skip the refetch since we don't know
    // which scope to query.
    const projectId = this.getState().loadedProjectId;
    if (projectId) {
      const taskId = (event.data as { taskId?: unknown } | undefined)?.taskId;
      const taskScope = typeof taskId === 'string' ? taskId : undefined;
      // void on purpose — failures bubble through the load() error
      // pathway. We deliberately do NOT await: handleEvent must stay
      // synchronous (the registry calls all stores' handleEvent in a
      // tight loop and one slow refetch shouldn't block the others).
      void this.load(projectId, taskScope).catch(() => {
        /* swallowed: load() already wrote state.error via runAction */
      });
    }
    return true;
  }
}
