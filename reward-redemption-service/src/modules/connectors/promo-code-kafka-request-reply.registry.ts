/**
 * T-RR-081. `PromoCodeKafkaRequestReplyRegistry` — the in-memory `correlationId -> pending
 * resolver` map that makes promo-code-service's genuinely asynchronous Kafka request/reply pair
 * (`promo-code.generate.requested.v1` / `promo-code.generate.result.v1`,
 * `promo-code-service-plan/02-KAFKA-CONTRACTS.md` §3/§4/§5) present itself to
 * `PromoCodeServiceConnector` as an ordinary `Promise<PromoCodeGenerateResultData>` — the task
 * file's own framing: "the async round trip present[s] itself to the rest of the pipeline as an
 * ordinary `Promise<RedemptionResult>`."
 *
 * Deliberately its own small file, with no `kafkajs`/NestJS-transport dependency at all — pure
 * `Map` + `setTimeout` bookkeeping, unit-testable without a real Kafka broker (implementation
 * note 1). `PromoCodeServiceKafkaClient` is the only caller: it calls `register()` before
 * publishing the request (never after — see that class's own header for why publish-before-register
 * would race a very fast reply) and `resolveResult()`/`cancel()` from, respectively, its shared
 * consumer's message handler and its own publish-failure path.
 *
 * **Idempotency boundary**: `02-KAFKA-CONTRACTS.md` §4 confirms promo-code-service itself already
 * deduplicates on `correlation_id` — a redelivered *request* produces the exact same *result*,
 * never a second code (that guarantee lives entirely on promo-code-service's own side). This
 * registry only ever guards against *its own* double-registration — reusing a `correlationId`
 * that is already pending is a bug in this connector's own correlationId generation (every
 * `redeem()` call is expected to mint a fresh one), never a case to paper over by silently
 * overwriting the earlier pending entry and orphaning its promise/timer (implementation note 2).
 */
import { Injectable, Logger } from '@nestjs/common';

/**
 * Thrown by `register()` when `resolveResult()`/`cancel()` never reach a real result before the
 * configured window elapses — the request may still be processing on promo-code-service's own
 * side; this is a `RETRYABLE_FAILURE` from `PromoCodeServiceConnector`'s point of view (that
 * class's own mapping), never a same-call fallback to another transport (implementation note 3:
 * "this service's own existing retry orchestration ... is what decides whether/when to retry the
 * whole redemption, not this connector re-publishing a second request itself").
 */
export class PromoCodeKafkaReplyTimeoutError extends Error {
  constructor(
    public readonly correlationId: string,
    public readonly timeoutMs: number,
  ) {
    super(
      `No promo-code.generate.result.v1 message received for correlationId "${correlationId}" ` +
        `within ${timeoutMs}ms`,
    );
    this.name = 'PromoCodeKafkaReplyTimeoutError';
  }
}

/**
 * Thrown by `register()` when `correlationId` is already pending — a bug upstream in this
 * connector's own correlationId generation (implementation note 2), never a normal runtime
 * condition. Deliberately not caught/converted to a `RedemptionResult` anywhere in this module —
 * `PromoCodeServiceConnector` lets it propagate rather than silently guessing which of the two
 * concurrent callers "wins," per `AGENT-PROTOCOL.md` §7's "escalate rather than guess."
 */
export class DuplicatePendingCorrelationIdError extends Error {
  constructor(public readonly correlationId: string) {
    super(
      `PromoCodeKafkaRequestReplyRegistry: correlationId "${correlationId}" is already pending — ` +
        'a second register() call for the same id indicates a bug in correlationId generation, ' +
        'not a case this registry silently overwrites.',
    );
    this.name = 'DuplicatePendingCorrelationIdError';
  }
}

interface PendingEntry<T> {
  resolve: (data: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

@Injectable()
export class PromoCodeKafkaRequestReplyRegistry<T = unknown> {
  private readonly logger = new Logger(PromoCodeKafkaRequestReplyRegistry.name);
  private readonly pending = new Map<string, PendingEntry<T>>();

  /**
   * Registers a pending resolver for `correlationId` and returns the promise
   * `PromoCodeServiceConnector` ultimately awaits. Rejects with `PromoCodeKafkaReplyTimeoutError`
   * if neither `resolveResult()` nor `cancel()` is called for this `correlationId` within
   * `timeoutMs` — the timer is armed synchronously, before this method returns, so the caller's
   * own "register, then publish" ordering never leaves a window where a message could arrive with
   * genuinely no timer running.
   *
   * Throws `DuplicatePendingCorrelationIdError` synchronously (never returns a rejected promise
   * for this case) if `correlationId` is already pending — this class's own header.
   */
  register(correlationId: string, timeoutMs: number): Promise<T> {
    if (this.pending.has(correlationId)) {
      throw new DuplicatePendingCorrelationIdError(correlationId);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new PromoCodeKafkaReplyTimeoutError(correlationId, timeoutMs));
      }, timeoutMs);
      this.pending.set(correlationId, { resolve, reject, timer });
    });
  }

  /**
   * Called by `PromoCodeServiceKafkaClient`'s shared consumer message handler when a
   * `promo-code.generate.result.v1` message arrives. A `correlationId` with no pending entry — a
   * redelivered request's second result, or a result that arrives after this registry's own
   * timeout already fired (TC-3) — is logged and dropped, never thrown: the shared consumer serves
   * every other still-pending caller and must never crash because one message was late.
   */
  resolveResult(correlationId: string, data: T): void {
    const entry = this.pending.get(correlationId);
    if (!entry) {
      this.logger.warn(
        `PromoCodeKafkaRequestReplyRegistry: no pending entry for correlationId ` +
          `"${correlationId}" — a late or redelivered promo-code.generate.result.v1 message, dropped.`,
      );
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(correlationId);
    entry.resolve(data);
  }

  /**
   * Called by `PromoCodeServiceKafkaClient` when publishing the request itself failed (the
   * request was never actually sent, so no result can ever arrive for it) — releases the pending
   * entry and its timer immediately, rather than leaving it to leak for the full timeout window. A
   * `correlationId` with no pending entry is a no-op (defensive only; every real caller registers
   * before it can ever reach a publish-failure path).
   */
  cancel(correlationId: string, reason: Error): void {
    const entry = this.pending.get(correlationId);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(correlationId);
    entry.reject(reason);
  }

  /** Exposed purely for a leak test (`AGENT-PROTOCOL.md`'s own Definition of Done for this task:
   * "confirmed a timeout never leaves a dangling registry entry") — never used by production
   * logic. */
  get pendingCount(): number {
    return this.pending.size;
  }
}
