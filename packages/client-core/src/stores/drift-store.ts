import type { DriftAlert, ResolveDrift } from '@plansync/shared';
import type { ApiClient } from '../api-client';
import type { DomainEvent } from '../events';
import { Store, type BaseState } from '../store-base';

export interface DriftState extends BaseState {
  byId: Record<string, DriftAlert>;
  /** Ids of currently-open drift alerts (the only ones the UI surfaces). */
  openIds: string[];
  loadedProjectId: string | null;
}

const initial: DriftState = {
  status: 'idle',
  byId: {},
  openIds: [],
  loadedProjectId: null,
};

function recomputeOpen(byId: Record<string, DriftAlert>): string[] {
  return Object.values(byId)
    .filter((d) => d.status === 'open')
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .map((d) => d.id);
}

export class DriftStore extends Store<DriftState> {
  constructor(private readonly api: ApiClient) {
    super(initial);
  }

  async load(projectId: string): Promise<DriftAlert[]> {
    this.transition('loading');
    try {
      const alerts = await this.api.drift.list(projectId);
      const byId = Object.fromEntries(alerts.map((a) => [a.id, a]));
      this.transition('ready', (state) => ({
        ...state,
        loadedProjectId: projectId,
        byId,
        openIds: recomputeOpen(byId),
      }));
      return alerts;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.transition('error', (state) => ({ ...state, error: error.message }));
      throw error;
    }
  }

  async resolve(projectId: string, driftId: string, body: ResolveDrift): Promise<DriftAlert> {
    const before = this.getState().byId[driftId];
    return this.runAction({
      // Optimistic: hide the alert from the open list immediately so the
      // banner clears. The authoritative resolvedAt / resolvedBy fields
      // are filled in by `onSuccess` once the server responds.
      optimistic: before
        ? (state) => {
            const next: DriftAlert = {
              ...before,
              status: 'resolved',
              resolvedAction: body.action,
            };
            const byId = { ...state.byId, [driftId]: next };
            return { ...state, byId, openIds: recomputeOpen(byId) };
          }
        : undefined,
      action: () => this.api.drift.resolve(projectId, driftId, body),
      onSuccess: (state, resolved) => {
        const byId = { ...state.byId, [resolved.id]: resolved };
        return { ...state, byId, openIds: recomputeOpen(byId) };
      },
    });
  }

  handleEvent(event: DomainEvent): boolean {
    switch (event.type) {
      case 'drift_detected':
      case 'drift_resolved': {
        const drift = (event.data?.drift ?? null) as DriftAlert | null;
        if (!drift) return false;
        this.setState((state) => {
          const byId = { ...state.byId, [drift.id]: drift };
          return { ...state, byId, openIds: recomputeOpen(byId) };
        });
        return true;
      }
      default:
        return false;
    }
  }
}
