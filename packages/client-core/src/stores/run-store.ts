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
    switch (event.type) {
      case 'execution_started':
      case 'execution_stale':
      case 'execution_failed':
      case 'execution_superseded': {
        const run = (event.data?.run ?? null) as ExecutionRun | null;
        if (!run) return false;
        this.setState((state) => {
          const byId = { ...state.byId, [run.id]: run };
          return { ...state, byId, activeIds: recomputeActive(byId) };
        });
        return true;
      }
      default:
        return false;
    }
  }
}
