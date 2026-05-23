/**
 * R-200: Transport-agnostic contract that every PlanSync UI surface must
 * implement to drive the shared store layer.
 *
 * The CLI, Web RSC, and Web client all reach for the same set of REST
 * endpoints today via ad-hoc `psRequest` / `fetch` calls. This interface
 * captures those calls as a small, typed API so that stores never know
 * which transport (Node `http`, browser `fetch`, server-side Next.js
 * fetcher) is in use.
 *
 * Three layers of access are exposed:
 *
 *   - Typed resource methods (`projects.list`, `tasks.update`, etc.) —
 *     stores should prefer these. New resources should be added here
 *     instead of inside any single transport implementation.
 *   - `request<T>(method, path, body?)` — escape hatch for one-off
 *     endpoints (suggestions, exec context, …) that haven't been folded
 *     into the typed surface yet. Keeps the contract small without
 *     forcing every consumer to wait on a full typing pass.
 *   - `subscribeEvents(handler)` — optional SSE/event-bus hook. Surfaces
 *     that don't support live updates may omit it and the stores will
 *     fall back to manual `refresh` calls.
 *
 * No transport implementation lives here — R-201 will wire CLI/Web to
 * concrete fetchers. Tests use `MockApiClient` in `tests/mock-api.ts`.
 */
import type {
  Project,
  CreateProject,
  UpdateProject,
  Plan,
  CreatePlan,
  UpdatePlan,
  Task,
  CreateTask,
  UpdateTask,
  ExecutionRun,
  CreateExecutionRun,
  CompleteExecutionRun,
  DriftAlert,
  ResolveDrift,
  PaginatedResponse,
} from '@plansync/shared';

import type { DomainEvent } from './events';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ProjectsApi {
  list(): Promise<Project[]>;
  get(projectId: string): Promise<Project>;
  create(body: CreateProject): Promise<Project>;
  update(projectId: string, body: UpdateProject): Promise<Project>;
}

export interface PlansApi {
  list(projectId: string): Promise<Plan[]>;
  get(projectId: string, planId: string): Promise<Plan>;
  /** Returns the currently active plan or `null` if none has been activated. */
  active(projectId: string): Promise<Plan | null>;
  create(projectId: string, body: CreatePlan): Promise<Plan>;
  update(projectId: string, planId: string, body: UpdatePlan): Promise<Plan>;
  propose(projectId: string, planId: string, reviewers?: string[]): Promise<Plan>;
  activate(projectId: string, planId: string): Promise<Plan>;
}

export interface TaskQuery {
  status?: string;
  assignee?: string;
  page?: number;
  pageSize?: number;
}

export interface TasksApi {
  list(projectId: string, query?: TaskQuery): Promise<PaginatedResponse<Task> | Task[]>;
  get(projectId: string, taskId: string): Promise<Task>;
  create(projectId: string, body: CreateTask): Promise<Task>;
  update(projectId: string, taskId: string, body: UpdateTask): Promise<Task>;
  delete(projectId: string, taskId: string): Promise<void>;
}

export interface RunsApi {
  /** Start a new execution run for a task. */
  start(projectId: string, taskId: string, body: CreateExecutionRun): Promise<ExecutionRun>;
  heartbeat(projectId: string, runId: string): Promise<ExecutionRun>;
  complete(projectId: string, runId: string, body: CompleteExecutionRun): Promise<ExecutionRun>;
  list(projectId: string, taskId?: string): Promise<ExecutionRun[]>;
}

export interface DriftApi {
  list(projectId: string, status?: 'open' | 'resolved'): Promise<DriftAlert[]>;
  resolve(projectId: string, driftId: string, body: ResolveDrift): Promise<DriftAlert>;
}

/**
 * Per-call SSE-style event handler returned from `subscribeEvents`.
 * Returning the function unsubscribes the listener; calling it twice is a
 * no-op.
 */
export type Unsubscribe = () => void;

export interface EventSubscriptionOptions {
  /**
   * Optional projectId scope. When set, the transport should only fan
   * events whose `projectId` matches; when unset, transports MAY relay
   * cross-project events (e.g. `my_work` updates).
   */
  projectId?: string;
}

export interface ApiClient {
  projects: ProjectsApi;
  plans: PlansApi;
  tasks: TasksApi;
  runs: RunsApi;
  drift: DriftApi;

  /**
   * Escape hatch for endpoints not yet covered by the typed surface.
   * Returns the parsed JSON body (or `undefined` for empty 2xx).
   */
  request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T>;

  /**
   * Subscribe to live domain events. Returns an unsubscribe function.
   * Transports that don't support push delivery (e.g. RSC pre-render)
   * may return a no-op unsubscriber — stores will then rely on explicit
   * `refresh()` calls to stay current.
   */
  subscribeEvents?(
    handler: (event: DomainEvent) => void,
    options?: EventSubscriptionOptions,
  ): Unsubscribe;
}
