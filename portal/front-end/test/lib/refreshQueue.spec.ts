/**
 * T-022 — `createSingleFlight`, the coalescer behind `apiClient`'s 401 handling.
 *
 * DoD requires 100% coverage on this file specifically (T-022's own Definition of Done),
 * so every branch — the "already in flight" reuse path, both settle outcomes, and a
 * second independent call after the first has settled — is exercised deliberately, not
 * just incidentally through `apiClient.spec.ts`'s higher-level TC-5.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSingleFlight } from '../../src/lib/refreshQueue';

/** A deferred promise, so a test can control exactly when `task()` settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createSingleFlight', () => {
  it('runs the task and resolves with its value', async () => {
    const single = createSingleFlight<string>();
    await expect(single.run(() => Promise.resolve('done'))).resolves.toBe('done');
  });

  it('is not in flight before the first call, and not after it settles', async () => {
    const single = createSingleFlight<string>();
    expect(single.isInFlight()).toBe(false);
    await single.run(() => Promise.resolve('done'));
    expect(single.isInFlight()).toBe(false);
  });

  it('is in flight while the task is pending', async () => {
    const single = createSingleFlight<string>();
    const { promise, resolve } = deferred<string>();
    const runPromise = single.run(() => promise);

    expect(single.isInFlight()).toBe(true);
    resolve('done');
    await runPromise;
    expect(single.isInFlight()).toBe(false);
  });

  it('TC-5 (unit level) — a second call while the first is in flight reuses the same promise and does not call the task again', async () => {
    const single = createSingleFlight<string>();
    const task = vi.fn(() => deferred<string>().promise);

    const first = single.run(task);
    const second = single.run(task);
    // `run` schedules `task` via a microtask (see its own comment on why) — flush one tick
    // so it has actually run before asserting the call count.
    await Promise.resolve();

    expect(task).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('every caller waiting on the in-flight call resolves together, from the same result', async () => {
    const single = createSingleFlight<number>();
    const { promise, resolve } = deferred<number>();
    const task = vi.fn(() => promise);

    const callers = [single.run(task), single.run(task), single.run(task)];
    resolve(42);

    await expect(Promise.all(callers)).resolves.toEqual([42, 42, 42]);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('every caller waiting on the in-flight call rejects together, from the same failure', async () => {
    const single = createSingleFlight<number>();
    const { promise, reject } = deferred<number>();
    const task = vi.fn(() => promise);
    const failure = new Error('refresh failed');

    const callers = [single.run(task), single.run(task)].map((p) => p.catch((e: unknown) => e));
    reject(failure);

    const results = await Promise.all(callers);
    expect(results).toEqual([failure, failure]);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('a call after the previous one settled starts a genuinely new task (no permanent latch)', async () => {
    const single = createSingleFlight<string>();
    const task = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');

    await expect(single.run(task)).resolves.toBe('first');
    await expect(single.run(task)).resolves.toBe('second');
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight state even when the task throws synchronously rather than returning a rejected promise', async () => {
    const single = createSingleFlight<string>();
    const throwing = (): Promise<string> => {
      throw new Error('boom');
    };

    await expect(single.run(throwing)).rejects.toThrow('boom');
    expect(single.isInFlight()).toBe(false);
    // Proves the latch was really released: a following call runs a fresh task.
    await expect(single.run(() => Promise.resolve('recovered'))).resolves.toBe('recovered');
  });

  it('independent SingleFlight instances do not share state', async () => {
    const a = createSingleFlight<string>();
    const b = createSingleFlight<string>();
    const { promise } = deferred<string>();

    void a.run(() => promise);

    expect(a.isInFlight()).toBe(true);
    expect(b.isInFlight()).toBe(false);
  });
});
