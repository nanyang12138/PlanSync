/**
 * Hand-rolled mock for `ApiClient` used by the store tests. Each method
 * stores the call args in `calls.<method>` and returns whatever the
 * caller queued via `queue.<method>`.
 *
 * Keeping it bespoke (vs. vi.fn() everywhere) lets the tests assert
 * "the store dispatched exactly one update with these args" without
 * leaking implementation details into the production code.
 */
import type { Project, Plan, Task, DriftAlert, ExecutionRun } from '@plansync/shared';
import type {
  ApiClient,
  ProjectsApi,
  PlansApi,
  TasksApi,
  DriftApi,
  RunsApi,
  HttpMethod,
  Unsubscribe,
  EventSubscriptionOptions,
} from '../src/api-client';
import type { DomainEvent } from '../src/events';

type Resolver<T> = T | (() => T | Promise<T>);

async function unwrap<T>(value: Resolver<T>): Promise<T> {
  if (typeof value === 'function') return (value as () => T | Promise<T>)();
  return value;
}

export class MockApiClient implements ApiClient {
  public readonly calls = {
    projects: { list: [] as unknown[], create: [] as unknown[], update: [] as unknown[] },
    plans: { list: [] as unknown[], activate: [] as unknown[] },
    tasks: {
      list: [] as unknown[],
      create: [] as unknown[],
      update: [] as unknown[],
      delete: [] as unknown[],
    },
    drift: { list: [] as unknown[], resolve: [] as unknown[] },
    runs: { list: [] as unknown[], start: [] as unknown[], complete: [] as unknown[] },
    request: [] as unknown[],
  };

  public queue: {
    projectsList?: Resolver<Project[]>;
    projectsCreate?: Resolver<Project>;
    projectsUpdate?: Resolver<Project>;
    plansList?: Resolver<Plan[]>;
    plansActivate?: Resolver<Plan>;
    tasksList?: Resolver<Task[]>;
    tasksCreate?: Resolver<Task>;
    tasksUpdate?: Resolver<Task>;
    tasksDelete?: Resolver<void>;
    driftList?: Resolver<DriftAlert[]>;
    driftResolve?: Resolver<DriftAlert>;
    runsList?: Resolver<ExecutionRun[]>;
    runsStart?: Resolver<ExecutionRun>;
    runsComplete?: Resolver<ExecutionRun>;
  } = {};

  private subscribers: Array<{
    handler: (event: DomainEvent) => void;
    options?: EventSubscriptionOptions;
  }> = [];

  projects: ProjectsApi = {
    list: async () => {
      this.calls.projects.list.push(null);
      return unwrap(this.queue.projectsList ?? []);
    },
    get: async () => {
      throw new Error('not implemented in mock');
    },
    create: async (body) => {
      this.calls.projects.create.push(body);
      return unwrap(this.queue.projectsCreate as Resolver<Project>);
    },
    update: async (projectId, body) => {
      this.calls.projects.update.push({ projectId, body });
      return unwrap(this.queue.projectsUpdate as Resolver<Project>);
    },
  };

  plans: PlansApi = {
    list: async (projectId) => {
      this.calls.plans.list.push({ projectId });
      return unwrap(this.queue.plansList ?? []);
    },
    get: async () => {
      throw new Error('not implemented in mock');
    },
    active: async () => null,
    create: async () => {
      throw new Error('not implemented in mock');
    },
    update: async () => {
      throw new Error('not implemented in mock');
    },
    propose: async () => {
      throw new Error('not implemented in mock');
    },
    activate: async (projectId, planId) => {
      this.calls.plans.activate.push({ projectId, planId });
      return unwrap(this.queue.plansActivate as Resolver<Plan>);
    },
  };

  tasks: TasksApi = {
    list: async (projectId, query) => {
      this.calls.tasks.list.push({ projectId, query });
      return unwrap(this.queue.tasksList ?? []);
    },
    get: async () => {
      throw new Error('not implemented in mock');
    },
    create: async (projectId, body) => {
      this.calls.tasks.create.push({ projectId, body });
      return unwrap(this.queue.tasksCreate as Resolver<Task>);
    },
    update: async (projectId, taskId, body) => {
      this.calls.tasks.update.push({ projectId, taskId, body });
      return unwrap(this.queue.tasksUpdate as Resolver<Task>);
    },
    delete: async (projectId, taskId) => {
      this.calls.tasks.delete.push({ projectId, taskId });
      return unwrap(this.queue.tasksDelete ?? undefined);
    },
  };

  drift: DriftApi = {
    list: async (projectId, status) => {
      this.calls.drift.list.push({ projectId, status });
      return unwrap(this.queue.driftList ?? []);
    },
    resolve: async (projectId, driftId, body) => {
      this.calls.drift.resolve.push({ projectId, driftId, body });
      return unwrap(this.queue.driftResolve as Resolver<DriftAlert>);
    },
  };

  runs: RunsApi = {
    list: async (projectId, taskId) => {
      this.calls.runs.list.push({ projectId, taskId });
      return unwrap(this.queue.runsList ?? []);
    },
    start: async (projectId, taskId, body) => {
      this.calls.runs.start.push({ projectId, taskId, body });
      return unwrap(this.queue.runsStart as Resolver<ExecutionRun>);
    },
    heartbeat: async () => {
      throw new Error('not implemented in mock');
    },
    complete: async (projectId, runId, body) => {
      this.calls.runs.complete.push({ projectId, runId, body });
      return unwrap(this.queue.runsComplete as Resolver<ExecutionRun>);
    },
  };

  async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    this.calls.request.push({ method, path, body });
    return undefined as unknown as T;
  }

  subscribeEvents(
    handler: (event: DomainEvent) => void,
    options?: EventSubscriptionOptions,
  ): Unsubscribe {
    const entry = { handler, options };
    this.subscribers.push(entry);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== entry);
    };
  }

  /** Test helper: deliver an event to every active subscriber. */
  emit(event: DomainEvent): void {
    for (const { handler, options } of this.subscribers) {
      if (options?.projectId && event.projectId && event.projectId !== options.projectId) continue;
      handler(event);
    }
  }

  get subscriberCount(): number {
    return this.subscribers.length;
  }
}
