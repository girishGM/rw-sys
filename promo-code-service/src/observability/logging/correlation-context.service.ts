/**
 * T-PC-042. Request-scoped `correlationId`/`tenantId`/`transport` context, backed by Node's own
 * `AsyncLocalStorage` — implementation note 1: "threaded through as request-scoped context, not
 * passed as an explicit parameter to every single function call". A log call deep inside any
 * service (`PromoCodeGenerationService`, the outbox publisher, ...) can read
 * `CorrelationContextService.getCurrent()` without that service's own method signature ever
 * needing a `correlationId` parameter added purely for logging's sake.
 *
 * `storage` is a `static` field, deliberately not an instance field, so this works correctly
 * regardless of how many separate `CorrelationContextService` instances Nest constructs across
 * different DI containers in the same OS process (each Nest `TestingModule`/microservice root
 * gets its own DI graph, but `AsyncLocalStorage` itself must be the same singleton store for
 * `run()` and `getCurrent()` to ever see each other's context, since both are ultimately just
 * thin wrappers around this one Node primitive).
 */
import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export type Transport = 'HTTP' | 'KAFKA' | 'GRPC';

export interface CorrelationContext {
  /** The one identifier that must appear on every log line for a single request's lifecycle. */
  correlationId: string;
  tenantId?: string;
  transport?: Transport;
  /** e.g. a Kafka event type or a gRPC method name — implementation notes' "eventType/rpc name". */
  rpc?: string;
}

@Injectable()
export class CorrelationContextService {
  private static readonly storage = new AsyncLocalStorage<CorrelationContext>();

  /**
   * Runs `fn` (and everything it awaits, synchronously or asynchronously, per
   * `AsyncLocalStorage`'s own propagation guarantee) with `context` visible to every
   * `getCurrent()`/`getCorrelationId()` call made anywhere in that call tree.
   */
  run<T>(context: CorrelationContext, fn: () => T): T {
    return CorrelationContextService.storage.run(context, fn);
  }

  getCurrent(): CorrelationContext | undefined {
    return CorrelationContextService.storage.getStore();
  }

  getCorrelationId(): string | undefined {
    return this.getCurrent()?.correlationId;
  }
}
