import type { Task, CreateTask, UpdateTask, PaginatedResponse } from '@plansync/shared';
import type { ApiClient, TaskQuery } from '../api-client';
import type { DomainEvent } from '../events';
import { Store, type BaseState } from '../store-base';

export interface TaskState extends BaseState {
  byId: Record<string, Task>;
  order: string[];
  loadedProjectId: string | null;
}

const initial: TaskState = {
  status: 'idle',
  byId: {},
  order: [],
  loadedProjectId: null,
};

function unwrap(list: PaginatedResponse<Task> | Task[]): Task[] {
  return Array.isArray(list) ? list : list.data;
}

export class TaskStore extends Store<TaskState> {
  constructor(private readonly api: ApiClient) {
    super(initial);
  }

  async load(projectId: string, query?: TaskQuery): Promise<Task[]> {
    this.transition('loading');
    try {
      const response = await this.api.tasks.list(projectId, query);
      const list = unwrap(response);
      this.transition('ready', (state) => ({
        ...state,
        loadedProjectId: projectId,
        byId: Object.fromEntries(list.map((t) => [t.id, t])),
        order: list.map((t) => t.id),
      }));
      return list;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.transition('error', (state) => ({ ...state, error: error.message }));
      throw error;
    }
  }

  async create(projectId: string, body: CreateTask): Promise<Task> {
    return this.runAction({
      action: () => this.api.tasks.create(projectId, body),
      onSuccess: (state, task) => ({
        ...state,
        byId: { ...state.byId, [task.id]: task },
        order: state.order.includes(task.id) ? state.order : [...state.order, task.id],
      }),
    });
  }

  /**
   * Optimistic update: applies `body` to the in-memory row immediately
   * so the UI repaints without waiting for the server, then reconciles
   * with the authoritative response. On failure the optimistic patch is
   * rolled back by `runAction` before the error surfaces.
   */
  async update(projectId: string, taskId: string, body: UpdateTask): Promise<Task> {
    const before = this.getState().byId[taskId];
    return this.runAction({
      optimistic: before
        ? (state) => ({
            ...state,
            byId: {
              ...state.byId,
              [taskId]: { ...before, ...(body as Partial<Task>) } as Task,
            },
          })
        : undefined,
      action: () => this.api.tasks.update(projectId, taskId, body),
      onSuccess: (state, task) => ({
        ...state,
        byId: { ...state.byId, [task.id]: task },
      }),
    });
  }

  async delete(projectId: string, taskId: string): Promise<void> {
    const before = this.getState();
    await this.runAction({
      optimistic: (state) => ({
        ...state,
        byId: Object.fromEntries(Object.entries(state.byId).filter(([id]) => id !== taskId)),
        order: state.order.filter((id) => id !== taskId),
      }),
      action: () => this.api.tasks.delete(projectId, taskId),
      onSuccess: (state) => state,
      onFailure: () => before,
    });
  }

  handleEvent(event: DomainEvent): boolean {
    switch (event.type) {
      case 'task_created':
      case 'task_assigned':
      case 'task_unassigned':
      case 'task_started':
      case 'task_completed':
      case 'task_cancelled':
      case 'task_claimed':
      case 'task_declined':
      case 'task_rebound': {
        const task = (event.data?.task ?? null) as Task | null;
        if (!task) return false;
        this.setState((state) => {
          const isNew = !state.byId[task.id];
          return {
            ...state,
            byId: { ...state.byId, [task.id]: task },
            order: isNew ? [...state.order, task.id] : state.order,
          };
        });
        return true;
      }
      case 'task_deleted': {
        const taskId = (event.data?.taskId ?? null) as string | null;
        if (!taskId) return false;
        this.setState((state) => ({
          ...state,
          byId: Object.fromEntries(Object.entries(state.byId).filter(([id]) => id !== taskId)),
          order: state.order.filter((id) => id !== taskId),
        }));
        return true;
      }
      default:
        return false;
    }
  }
}
