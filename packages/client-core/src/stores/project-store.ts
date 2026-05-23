import type { Project, UpdateProject, CreateProject } from '@plansync/shared';
import type { ApiClient } from '../api-client';
import type { DomainEvent } from '../events';
import { Store, type BaseState } from '../store-base';

export interface ProjectState extends BaseState {
  byId: Record<string, Project>;
  order: string[];
  /** The currently selected project id (CLI: `cfg.project`; Web: route param). */
  selectedId: string | null;
}

const initial: ProjectState = {
  status: 'idle',
  byId: {},
  order: [],
  selectedId: null,
};

export class ProjectStore extends Store<ProjectState> {
  constructor(private readonly api: ApiClient) {
    super(initial);
  }

  select(projectId: string | null): void {
    this.setState((state) => ({ ...state, selectedId: projectId }));
  }

  async load(): Promise<Project[]> {
    this.transition('loading');
    try {
      const list = await this.api.projects.list();
      this.transition('ready', (state) => ({
        ...state,
        byId: Object.fromEntries(list.map((p) => [p.id, p])),
        order: list.map((p) => p.id),
      }));
      return list;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.transition('error', (state) => ({ ...state, error: error.message }));
      throw error;
    }
  }

  async create(body: CreateProject): Promise<Project> {
    return this.runAction({
      action: () => this.api.projects.create(body),
      onSuccess: (state, created) => ({
        ...state,
        byId: { ...state.byId, [created.id]: created },
        order: [...state.order, created.id],
      }),
    });
  }

  async update(projectId: string, body: UpdateProject): Promise<Project> {
    const before = this.getState().byId[projectId];
    return this.runAction({
      optimistic: before
        ? (state) => ({
            ...state,
            byId: { ...state.byId, [projectId]: { ...before, ...body } as Project },
          })
        : undefined,
      action: () => this.api.projects.update(projectId, body),
      onSuccess: (state, updated) => ({
        ...state,
        byId: { ...state.byId, [updated.id]: updated },
      }),
    });
  }

  /**
   * Apply a domain event. Returns true if state changed (useful for
   * tests; UIs just re-render via the subscription).
   *
   * Unknown event types are ignored — the SSE dispatcher routes every
   * event to every store, and stores opt in to the ones they care
   * about.
   */
  handleEvent(event: DomainEvent): boolean {
    switch (event.type) {
      case 'project_created':
      case 'project_updated':
      case 'project_closed':
      case 'project_reopened': {
        const project = (event.data?.project ?? null) as Project | null;
        if (!project) return false;
        let changed = false;
        this.setState((state) => {
          const existing = state.byId[project.id];
          const next: ProjectState = {
            ...state,
            byId: { ...state.byId, [project.id]: project },
            order: existing ? state.order : [...state.order, project.id],
          };
          changed = true;
          return next;
        });
        return changed;
      }
      default:
        return false;
    }
  }
}
