/**
 * R-200: `@plansync/client-core` public surface.
 *
 * The package is consumed by R-201 (CLI + Web both replace direct
 * `psRequest` / `fetch` calls with store actions) and by integration
 * tests that want a deterministic in-memory view-model layer.
 */
export type {
  ApiClient,
  ProjectsApi,
  PlansApi,
  TasksApi,
  RunsApi,
  DriftApi,
  TaskQuery,
  HttpMethod,
  Unsubscribe,
  EventSubscriptionOptions,
} from './api-client';

export { Store, InvalidTransitionError } from './store-base';
export type { BaseState, StoreStatus, Listener } from './store-base';

export type { DomainEvent } from './events';
export { isEventOfType } from './events';

export { ProjectStore } from './stores/project-store';
export type { ProjectState } from './stores/project-store';

export { PlanStore } from './stores/plan-store';
export type { PlanState } from './stores/plan-store';

export { TaskStore } from './stores/task-store';
export type { TaskState } from './stores/task-store';

export { DriftStore } from './stores/drift-store';
export type { DriftState } from './stores/drift-store';

export { RunStore } from './stores/run-store';
export type { RunState } from './stores/run-store';

export { createStoreRegistry } from './store-registry';
export type { StoreRegistry } from './store-registry';
