/**
 * T-RR-081 — `PromoCodeKafkaRequestReplyRegistry`, unit-tested as pure `Map`/`setTimeout`
 * bookkeeping with no `kafkajs`/broker dependency at all (this class's own header: "unit-testable
 * without a real Kafka broker"). Covers TC-2/TC-3 of the task file directly, plus the Definition
 * of Done's own explicit memory-leak requirement ("confirmed a timeout never leaves a dangling
 * registry entry") via `pendingCount`.
 */
import 'reflect-metadata';
import {
  DuplicatePendingCorrelationIdError,
  PromoCodeKafkaReplyTimeoutError,
  PromoCodeKafkaRequestReplyRegistry,
} from '@/modules/connectors/promo-code-kafka-request-reply.registry';

describe('T-RR-081 — PromoCodeKafkaRequestReplyRegistry', () => {
  it('register() then resolveResult() with a matching correlationId resolves the promise with the delivered data, and clears the pending entry', async () => {
    const registry = new PromoCodeKafkaRequestReplyRegistry<{ value: string }>();

    const promise = registry.register('corr-1', 5_000);
    expect(registry.pendingCount).toBe(1);
    registry.resolveResult('corr-1', { value: 'hello' });

    await expect(promise).resolves.toEqual({ value: 'hello' });
    expect(registry.pendingCount).toBe(0);
  });

  it('TC-2: no result ever arrives -> the promise rejects with PromoCodeKafkaReplyTimeoutError at the configured timeout, not before, not indefinitely, and the entry is removed', async () => {
    jest.useFakeTimers();
    try {
      const registry = new PromoCodeKafkaRequestReplyRegistry<{ value: string }>();
      const promise = registry.register('corr-2', 1_000);
      const assertion = expect(promise).rejects.toBeInstanceOf(PromoCodeKafkaReplyTimeoutError);

      // Not before: the entry is still pending just short of the deadline.
      jest.advanceTimersByTime(999);
      expect(registry.pendingCount).toBe(1);

      // At the configured deadline, and not indefinitely after.
      jest.advanceTimersByTime(1);
      await assertion;
      expect(registry.pendingCount).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('TC-3: a result arrives for a correlationId with no pending entry (late, post-timeout) is logged and dropped, never thrown', () => {
    const registry = new PromoCodeKafkaRequestReplyRegistry<{ value: string }>();
    const warnSpy = jest.spyOn(
      (registry as unknown as { logger: { warn: () => void } }).logger,
      'warn',
    );

    expect(() => registry.resolveResult('never-registered', { value: 'late' })).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(registry.pendingCount).toBe(0);
  });

  it('a late result for a correlationId that already resolved is also dropped, never re-resolves or throws', async () => {
    const registry = new PromoCodeKafkaRequestReplyRegistry<{ value: string }>();
    const promise = registry.register('corr-3', 5_000);
    registry.resolveResult('corr-3', { value: 'first' });
    await expect(promise).resolves.toEqual({ value: 'first' });

    expect(() => registry.resolveResult('corr-3', { value: 'redelivered' })).not.toThrow();
    // The original promise's own resolution is untouched — still 'first', never overwritten.
    await expect(promise).resolves.toEqual({ value: 'first' });
  });

  it('implementation note 2: registering an already-pending correlationId throws DuplicatePendingCorrelationIdError synchronously, never silently overwrites the earlier pending entry', async () => {
    const registry = new PromoCodeKafkaRequestReplyRegistry<{ value: string }>();
    const original = registry.register('corr-4', 5_000);

    expect(() => registry.register('corr-4', 5_000)).toThrow(DuplicatePendingCorrelationIdError);
    // The original pending entry is untouched — still exactly one, not zero, not two.
    expect(registry.pendingCount).toBe(1);

    // Cleanup: release the original pending entry's real 5s timer immediately rather than letting
    // it fire (and reject, unhandled) after this test file's own process has already exited.
    registry.cancel('corr-4', new Error('test cleanup'));
    await expect(original).rejects.toThrow('test cleanup');
  });

  it('cancel() rejects the pending promise immediately with the given reason and clears its timer, without waiting out the full timeout window', async () => {
    jest.useFakeTimers();
    try {
      const registry = new PromoCodeKafkaRequestReplyRegistry<{ value: string }>();
      const promise = registry.register('corr-5', 60_000);
      const reason = new Error('publish failed');

      registry.cancel('corr-5', reason);

      await expect(promise).rejects.toBe(reason);
      expect(registry.pendingCount).toBe(0);
      // No dangling timer left running for the full 60s window.
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancel() on a correlationId with no pending entry is a harmless no-op', () => {
    const registry = new PromoCodeKafkaRequestReplyRegistry<{ value: string }>();
    expect(() => registry.cancel('never-registered', new Error('x'))).not.toThrow();
    expect(registry.pendingCount).toBe(0);
  });

  it('multiple independent correlationIds resolve/timeout independently of one another', async () => {
    jest.useFakeTimers();
    try {
      const registry = new PromoCodeKafkaRequestReplyRegistry<{ value: string }>();
      const fast = registry.register('corr-fast', 10_000);
      const slow = registry.register('corr-slow', 10_000);
      expect(registry.pendingCount).toBe(2);

      registry.resolveResult('corr-fast', { value: 'fast-result' });
      await expect(fast).resolves.toEqual({ value: 'fast-result' });
      expect(registry.pendingCount).toBe(1);

      const slowAssertion = expect(slow).rejects.toBeInstanceOf(PromoCodeKafkaReplyTimeoutError);
      jest.advanceTimersByTime(10_000);
      await slowAssertion;
      expect(registry.pendingCount).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
