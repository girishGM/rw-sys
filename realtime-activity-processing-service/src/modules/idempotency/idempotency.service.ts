import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { InboundActivity } from './inbound-activity.types';

/**
 * Delimiter used to join the composite dedup-key fields before hashing. A literal ASCII "Unit
 * Separator" control character (0x1F) — it cannot appear in the valid value of any of the five
 * joined fields (a customer id, an activity/transaction code, an ISO-8601 timestamp, a channel
 * code, or a decimal string), so no combination of field values can collide by shifting where the
 * delimiter falls.
 *
 * WARNING: this delimiter, the field order below, and the hash algorithm together define what an
 * already-persisted composite-fallback `dedup_key` value means. Changing any of the three is a
 * breaking change — a redelivered old-format message would hash differently and silently stop
 * deduping against its own prior insert (ARCHITECTURE.md §7, T-RAP-020 task file, implementation
 * note 2).
 */
const COMPOSITE_KEY_DELIMITER = '';

/**
 * T-RAP-020. `deriveDedupKey` is the one place the hybrid idempotency key
 * (`ARCHITECTURE.md` §7, confirmed decision) is computed — every downstream fan-out row this
 * activity produces (`01-DATABASE.md` §3) carries this same value.
 *
 * Pure and side-effect free by design (task file, implementation note 4): no DB access, no cache
 * access, no I/O. Given the same `InboundActivity` input this always produces the same output,
 * which is what makes it safe to call from both transport adapters (T-RAP-022, T-RAP-023) without
 * any shared mutable state, and safe to unit-test exhaustively.
 *
 * **Pending wiring (implementation note 5):** whether the composite fallback below is even
 * permitted is meant to be governed by the `dedup_composite_fallback_enabled` service-config flag
 * (`01-DATABASE.md` §11), resolved via T-RAP-013. That task has not landed yet, so this service
 * currently behaves as if the flag is always enabled (the documented default) — once T-RAP-013's
 * config resolver exists, the flag should be threaded into this method (or this service's
 * constructor) so a tenant/campaign that requires `activityEventId` can have the fallback path
 * throw instead of hash.
 */
@Injectable()
export class IdempotencyService {
  deriveDedupKey(activity: InboundActivity): string {
    if (activity.activityEventId && activity.activityEventId.length > 0) {
      // ARCHITECTURE.md §7 — the caller's own value, byte-for-byte: no hashing, no transformation.
      return activity.activityEventId;
    }

    const activityCodeOrTransactionType = activity.activityCode || activity.transactionType;
    if (!activityCodeOrTransactionType) {
      // Should already have been rejected by request validation upstream of this module
      // (01-DATABASE.md §3's app-layer "one of the two is required" check) — this module is not
      // the place that silently tolerates it by hashing `null`/`undefined` (task file, note 3).
      throw new Error(
        'Cannot derive dedupKey: activity has neither activityEventId, activityCode, nor transactionType.',
      );
    }

    const compositeInput = [
      activity.customerId,
      activityCodeOrTransactionType,
      activity.activityPerformedDate.toISOString(),
      activity.channel,
      activity.activityValue,
    ].join(COMPOSITE_KEY_DELIMITER);

    return createHash('sha256').update(compositeInput, 'utf8').digest('hex');
  }
}
