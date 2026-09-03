import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

/**
 * T-RAP-020. Every inbound activity gets exactly one `correlationId`, resolved once at the very
 * start of ingestion (`05-PROCESSING-PIPELINE.md` §1, step 1) and then attached to every log line
 * and every `activity_logs` row it ever produces (`01-DATABASE.md` §3's `correlation_id` column).
 *
 * Pure and side-effect free, same as `IdempotencyService`: the only "randomness" is the fresh
 * uuid generated when the caller didn't supply one, which is exactly the documented behaviour
 * (task file TC-6), not a violation of purity in any way that matters for testability — a caller
 * that always supplies its own `correlationId` gets fully deterministic behaviour out of this
 * service.
 */
@Injectable()
export class CorrelationIdService {
  /**
   * Returns `input` verbatim if the caller supplied a non-blank value, otherwise generates a
   * fresh RFC 4122 uuid.
   */
  resolve(input?: string): string {
    if (input && input.trim().length > 0) {
      return input;
    }
    return randomUUID();
  }
}
