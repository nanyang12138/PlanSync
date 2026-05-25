/**
 * R-200: Tiny reactive store primitive shared by every PlanSync UI store.
 *
 * Why not pull in zustand / nanostores? Both bring a peer-dep that the
 * CLI (esbuild → single CJS bundle) and the Web client (React Server +
 * Client component split) would have to wrestle with separately. The
 * surface area we actually need — `getState` + `subscribe` + `setState`
 * + state-machine guard — fits in ~40 lines, and keeping it in-house
 * lets us unit-test the state machine in isolation.
 */

export type StoreStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface BaseState {
  status: StoreStatus;
  /** Populated when `status === 'error'`. Cleared on the next successful action. */
  error?: string;
}

export type Listener<S> = (state: S, prev: S) => void;

/**
 * Allowed transitions for the per-store status FSM. Stores call
 * `transition` instead of mutating `state.status` directly so that an
 * out-of-order update (e.g. a late `ready` after we already entered
 * `error`) is rejected instead of silently clobbering the UI.
 *
 * `idle` is the bootstrap state every store starts in. From there:
 *   - `loading` → first `load()` in flight
 *   - `ready` → load succeeded
 *   - `error` → load failed; UI can `retry()` which goes back to
 *     `loading`
 *   - `ready` → `loading` is allowed (refresh while data is on screen)
 */
const ALLOWED_TRANSITIONS: Record<StoreStatus, StoreStatus[]> = {
  idle: ['loading', 'error'],
  loading: ['ready', 'error'],
  ready: ['loading', 'ready', 'error'],
  error: ['loading', 'error'],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: StoreStatus,
    public readonly to: StoreStatus,
  ) {
    super(`Invalid store transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class Store<S extends BaseState> {
  private current: S;
  private readonly listeners = new Set<Listener<S>>();
  /**
   * R5 / closes #940: monotonically increasing sequence number stamped
   * on every runAction at start. The success path only writes back if
   * its seq matches the current latest — so a late-arriving stale
   * success cannot overwrite a more-recent error.
   */
  private actionSeq = 0;
  private latestActionSeq = 0;

  constructor(initial: S) {
    this.current = initial;
  }

  getState(): S {
    return this.current;
  }

  subscribe(listener: Listener<S>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Apply an update and notify subscribers. Pass a function rather than
   * a partial object so callers can express derived updates atomically.
   */
  protected setState(updater: (state: S) => S): void {
    const prev = this.current;
    const next = updater(prev);
    if (next === prev) return;
    this.current = next;
    for (const listener of this.listeners) {
      listener(next, prev);
    }
  }

  protected transition(to: StoreStatus, patch: (state: S) => S = (s) => s): void {
    const from = this.current.status;
    if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
      throw new InvalidTransitionError(from, to);
    }
    this.setState((state) => ({ ...patch(state), status: to }));
  }

  /**
   * Convenience wrapper for actions that go loading → ready/error with
   * optional optimistic updates and automatic rollback on failure.
   *
   *   await this.runAction({
   *     optimistic: state => ({ ...state, list: [...state.list, tmp] }),
   *     action:     () => api.tasks.create(...),
   *     onSuccess:  (state, created) => ({ ...state, list: replace(tmp, created) }),
   *   });
   */
  protected async runAction<T>(opts: {
    optimistic?: (state: S) => S;
    action: () => Promise<T>;
    onSuccess: (state: S, result: T) => S;
    onFailure?: (state: S, error: Error) => S;
  }): Promise<T> {
    // R5 / closes #940: stamp this action with a fresh sequence number.
    // The success path checks the seq against the latest at that point;
    // if a later action started in between, this one's success is stale
    // and must NOT overwrite the newer state.
    this.actionSeq += 1;
    const seq = this.actionSeq;
    this.latestActionSeq = seq;

    const before = this.current;
    if (opts.optimistic) {
      this.setState(opts.optimistic);
    }
    try {
      const result = await opts.action();
      if (seq !== this.latestActionSeq) {
        // A newer action superseded us. Don't touch state — its handler
        // will own the next status flip. Still return the result so
        // direct callers (e.g. an immediate `.then`) can use it.
        return result;
      }
      // Closes #783: a previous failed action left state.status === 'error'.
      // The original implementation only patched `error: undefined` on
      // success, leaving `status: 'error'` in place — so the UI saw
      // "request failed" forever even after the next try worked. Always
      // flip to `ready` after a successful retry. (Allowed transitions
      // include error → ready and ready → ready, so this is safe to
      // apply unconditionally.)
      this.setState((state) => ({
        ...opts.onSuccess(state, result),
        status: 'ready',
        error: undefined,
      }));
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (seq !== this.latestActionSeq) {
        // A newer action superseded us. Don't roll back its progress.
        throw error;
      }
      // Roll back optimistic changes, then apply caller-supplied failure
      // patch (e.g. surface the error message on a specific row) and flip
      // status to `error`.
      this.setState(() => before);
      const patched = opts.onFailure ? opts.onFailure(this.current, error) : this.current;
      this.setState(() => ({ ...patched, status: 'error', error: error.message }));
      throw error;
    }
  }
}
