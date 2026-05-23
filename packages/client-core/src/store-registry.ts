/**
 * R-200: Bundle every store under a single registry so that an SSE
 * transport (or a CLI listener) only needs to wire up one event handler
 * to keep the entire UI in sync.
 *
 * Each store independently filters events it cares about — the
 * registry's only job is fan-out + duplicate suppression.
 */
import type { ApiClient, Unsubscribe } from './api-client';
import type { DomainEvent } from './events';
import { ProjectStore } from './stores/project-store';
import { PlanStore } from './stores/plan-store';
import { TaskStore } from './stores/task-store';
import { DriftStore } from './stores/drift-store';
import { RunStore } from './stores/run-store';

export interface StoreRegistry {
  projects: ProjectStore;
  plans: PlanStore;
  tasks: TaskStore;
  drift: DriftStore;
  runs: RunStore;
  handleEvent(event: DomainEvent): void;
  /**
   * If the underlying ApiClient supports `subscribeEvents`, connect
   * every store to it and return an unsubscriber. Otherwise returns a
   * no-op (transports without push delivery are expected to drive
   * `handleEvent` manually).
   */
  connect(options?: { projectId?: string }): Unsubscribe;
}

export function createStoreRegistry(api: ApiClient): StoreRegistry {
  const projects = new ProjectStore(api);
  const plans = new PlanStore(api);
  const tasks = new TaskStore(api);
  const drift = new DriftStore(api);
  const runs = new RunStore(api);

  const seen = new Set<string>();
  function handleEvent(event: DomainEvent): void {
    if (event.eventId) {
      if (seen.has(event.eventId)) return;
      seen.add(event.eventId);
      // Bound the dedupe set so it doesn't grow forever in long-lived
      // CLI sessions.
      if (seen.size > 1024) {
        const first = seen.values().next().value;
        if (first) seen.delete(first);
      }
    }
    projects.handleEvent(event);
    plans.handleEvent(event);
    tasks.handleEvent(event);
    drift.handleEvent(event);
    runs.handleEvent(event);
  }

  function connect(options?: { projectId?: string }): Unsubscribe {
    if (!api.subscribeEvents) return () => {};
    return api.subscribeEvents(handleEvent, options);
  }

  return { projects, plans, tasks, drift, runs, handleEvent, connect };
}
