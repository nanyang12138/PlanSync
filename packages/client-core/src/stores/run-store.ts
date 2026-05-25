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
      const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
      this.transition('ready', (state) => ({
        ...state,
        loadedProjectId: projectId,
        byId,
        activeIds: recomputeActive(byId),
      }));
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
    // also carry only run/task ids — not full run objects. We treat all
    // four uniformly: claim the event so the registry can fan it to
    // subscribers, merge a full run object if the payload happens to
    // include one, otherwise leave the store unchanged (caller refetches).
    const STORE_AFFECTING_EVENTS: ReadonlySet<string> = new Set([
      'task_started',
      'execution_stale',
      'execution_failed',
      'execution_superseded',
    ]);
    switch (event.type) {
      default: {
        if (!STORE_AFFECTING_EVENTS.has(event.type)) return false;
        // Closes #784 — the previous code expected `event.data.run` to be
        // a complete ExecutionRun, but every server-side publisher sends
        // lightweight ids only (avoids fanning out kilobyte payloads
        // through SSE and keeps the wire schema stable). When a full run
        // object is present (legacy / future events that opt in), use it
        // directly; otherwise return true to signal "the caller should
        // refetch via load()" — the live data path through the API is the
        // single source of truth for run state, the SSE event just tells
        // us "something changed".
        const run = (event.data as { run?: unknown } | undefined)?.run as ExecutionRun | undefined;
        if (run && typeof run === 'object' && typeof run.id === 'string') {
          this.setState((state) => {
            const byId = { ...state.byId, [run.id]: run };
            return { ...state, byId, activeIds: recomputeActive(byId) };
          });
        }
        // Always return true so subscribers see "an event affected this
        // store" and can decide to refetch. Returning false would have
        // signalled "store ignored the event"; that's only correct when
        // we're sure no run state changed.
        return true;
      }
    }
  }
}
