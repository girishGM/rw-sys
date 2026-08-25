/**
 * T-022 — the single-flight coalescer behind `apiClient`'s 401 handling
 * (04-FRONTEND.md §8, T-022 implementation note 3).
 *
 * ### The bug this exists to prevent
 *
 * A dashboard fires five parallel queries. The access token expired between page loads,
 * so all five come back 401 within milliseconds of each other. Each one, independently,
 * wants to refresh the session. Two things go wrong if that is allowed to happen
 * naively:
 *
 * 1. **N refreshes for N concurrent 401s.** `POST /auth/refresh` rotates the refresh
 *    token (02-SECURITY.md §3) — the *first* call to land consumes the current token and
 *    is issued a new one; every other call presents the now-*consumed* token and trips
 *    the server's reuse-detection path, which revokes the **entire session family** and
 *    logs the user out. A real 401 storm, refreshed naively, becomes a random logout.
 * 2. **Retrying more than once.** If a refresh itself keeps failing (session truly gone),
 *    a caller that does not remember "I already tried this" retries forever.
 *
 * ### The fix
 *
 * Coalesce concurrent callers onto **one** in-flight promise; `apiClient` is responsible
 * for the "retry each request exactly once" half (see its own `_retried` marker) — this
 * module only guarantees that whatever function it is given runs at most once at a time.
 *
 * Deliberately generic (not "the" refresh queue, despite the file name) — a `<void>`
 * instance for the refresh call is the only consumer today, but the coalescing logic
 * itself has nothing auth-specific in it, and keeping it that way is what makes 100%
 * coverage on this file cheap and durable.
 */

export interface SingleFlight<T> {
  /**
   * Runs `task` if nothing is currently in flight; otherwise returns the promise already
   * in flight without calling `task` again. All callers — the one that started it and
   * every one that arrived while it was running — resolve or reject together, from the
   * same underlying call.
   */
  readonly run: (task: () => Promise<T>) => Promise<T>;
  /** True from the moment `run` starts a new call until it settles. */
  readonly isInFlight: () => boolean;
}

/** A fresh, independent coalescer. Each call site that needs single-flight semantics gets its own. */
export function createSingleFlight<T>(): SingleFlight<T> {
  let pending: Promise<T> | null = null;

  const run = (task: () => Promise<T>): Promise<T> => {
    if (pending === null) {
      // `Promise.resolve().then(task)` rather than calling `task()` directly: a task that
      // throws *synchronously* (rather than returning a rejected promise) must still
      // become a rejected promise here, or `run` itself would throw instead of returning
      // one — every caller of `run` is written assuming it always hands back a promise.
      pending = Promise.resolve()
        .then(task)
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  };

  const isInFlight = (): boolean => pending !== null;

  return { run, isInFlight };
}
