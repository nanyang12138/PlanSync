import type { Plan, CreatePlan, UpdatePlan } from '@plansync/shared';
import type { ApiClient } from '../api-client';
import type { DomainEvent } from '../events';
import { Store, type BaseState } from '../store-base';

export interface PlanState extends BaseState {
  /** Indexed by planId. */
  byId: Record<string, Plan>;
  /** Plan ids in display order (newest version first). */
  order: string[];
  /** Currently active plan id for the loaded project, if any. */
  activeId: string | null;
  /** Currently proposed (awaiting review) plan id, if any. */
  proposedId: string | null;
  loadedProjectId: string | null;
}

const initial: PlanState = {
  status: 'idle',
  byId: {},
  order: [],
  activeId: null,
  proposedId: null,
  loadedProjectId: null,
};

function pickPointers(plans: Plan[]): Pick<PlanState, 'activeId' | 'proposedId'> {
  const active = plans.find((p) => p.status === 'active');
  const proposed = plans.find((p) => p.status === 'proposed');
  return {
    activeId: active?.id ?? null,
    proposedId: proposed?.id ?? null,
  };
}

export class PlanStore extends Store<PlanState> {
  constructor(private readonly api: ApiClient) {
    super(initial);
  }

  async load(projectId: string): Promise<Plan[]> {
    this.transition('loading');
    try {
      const plans = await this.api.plans.list(projectId);
      const ordered = [...plans].sort((a, b) => b.version - a.version);
      this.transition('ready', (state) => ({
        ...state,
        loadedProjectId: projectId,
        byId: Object.fromEntries(ordered.map((p) => [p.id, p])),
        order: ordered.map((p) => p.id),
        ...pickPointers(ordered),
      }));
      return ordered;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.transition('error', (state) => ({ ...state, error: error.message }));
      throw error;
    }
  }

  async create(projectId: string, body: CreatePlan): Promise<Plan> {
    return this.runAction({
      action: () => this.api.plans.create(projectId, body),
      onSuccess: (state, plan) => ({
        ...state,
        byId: { ...state.byId, [plan.id]: plan },
        order: [plan.id, ...state.order.filter((id) => id !== plan.id)],
        ...pickPointers([plan, ...state.order.map((id) => state.byId[id]).filter(Boolean)]),
      }),
    });
  }

  async update(projectId: string, planId: string, body: UpdatePlan): Promise<Plan> {
    return this.runAction({
      action: () => this.api.plans.update(projectId, planId, body),
      onSuccess: (state, plan) => ({
        ...state,
        byId: { ...state.byId, [plan.id]: plan },
      }),
    });
  }

  async activate(projectId: string, planId: string): Promise<Plan> {
    return this.runAction({
      action: () => this.api.plans.activate(projectId, planId),
      onSuccess: (state, plan) => {
        const next: Record<string, Plan> = { ...state.byId, [plan.id]: plan };
        // Any previously active plan must transition to `superseded` to
        // match server semantics (R-048: only one active plan per project).
        for (const id of state.order) {
          const cand = next[id];
          if (cand && cand.id !== plan.id && cand.status === 'active') {
            next[id] = { ...cand, status: 'superseded' };
          }
        }
        return {
          ...state,
          byId: next,
          activeId: plan.id,
          proposedId: state.proposedId === plan.id ? null : state.proposedId,
        };
      },
    });
  }

  handleEvent(event: DomainEvent): boolean {
    switch (event.type) {
      case 'plan_created':
      case 'plan_proposed':
      case 'plan_activated':
      case 'plan_reactivated':
      case 'plan_updated':
      case 'plan_superseded': {
        const plan = (event.data?.plan ?? null) as Plan | null;
        if (!plan) return false;
        this.setState((state) => {
          const byId = { ...state.byId, [plan.id]: plan };
          // R-048 invariant: at most one active plan per project. If the
          // incoming plan is active, force any other plan still marked
          // active in our local map to `superseded` — otherwise the
          // pointer recompute below would pick whichever entry iterates
          // first in object order.
          if (plan.status === 'active') {
            for (const id of Object.keys(byId)) {
              if (id !== plan.id && byId[id].status === 'active') {
                byId[id] = { ...byId[id], status: 'superseded' };
              }
            }
          }
          const all = Object.values(byId);
          return {
            ...state,
            byId,
            order: state.order.includes(plan.id) ? state.order : [plan.id, ...state.order],
            ...pickPointers(all),
          };
        });
        return true;
      }
      default:
        return false;
    }
  }
}
