/**
 * T-RR-034. Placeholder metrics counter for `reward_tracking_dispatch_tier_total{tier}`
 * (`07-CONFIGURABILITY-AND-OBSERVABILITY.md` §3) — this service's own `src/observability/`
 * module (the real `MetricsRegistry`) doesn't exist yet; it is T-RR-040's own file scope (Wave 4,
 * `agent-rap-qa`-equivalent `agent-rr-qa`), which depends on this task and audits that every named
 * metric in §3 increments at its real call site. Building this placeholder now — under the exact
 * metric name/label contract §3 already fixes — means that audit finds a real call site to adopt
 * (or swap this class's own internals for a real registry-backed one) rather than a gap to file a
 * defect against.
 *
 * In-memory only, deliberately: this is not a dashboard/alerting product (explicitly deferred,
 * `BACKLOG.md`, mirrored by §3's own closing line) — just a real, injectable, testable counter so
 * TC-10 ("increments once per successful publish, never on a failed attempt") is an actual
 * assertion against observable state, not a change-detector on a log line.
 */
import { Injectable } from '@nestjs/common';

/** The three tier values `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §3 names for this metric —
 * `'kafka'` (T-RR-034, this task), `'rest'`/`'retry_table'` (T-RR-035) — plus `'grpc'`, added by
 * T-RR-062 for the new third dispatch channel. **Deviation flagged for the architect**:
 * `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §3 (outside this task's own file scope to edit) still
 * documents only the original three values, and this service's own separate, "real" registry
 * (`src/observability/metrics.registry.ts`'s own `DispatchTier`, T-RR-040, `agent-rr-qa`'s file
 * scope) was deliberately left untouched here for the identical R3 reason — this task adds `'grpc'`
 * only to *this* file's own placeholder counter (the one `OutboxPublisherService` actually calls),
 * so `markDelivered()` can attribute a successful gRPC dispatch correctly instead of silently
 * miscounting it as `'rest'`. Reconciling the design doc's own fixed three-value list, and
 * `MetricsRegistry`'s own identically-named type, with this fourth value is a distinct, not-yet-filed
 * follow-up outside this task's own scope. */
export type DispatchTier = 'kafka' | 'rest' | 'grpc' | 'retry_table';

@Injectable()
export class DispatchMetricsService {
  private readonly counts = new Map<DispatchTier, number>();

  /**
   * T-INT-051 TC-3. A second, standalone counter (not a `DispatchTier` value — poisoning a row is
   * not a delivery outcome on any tier, it is the outcome of *never* reaching tier selection at
   * all) for `reward_tracking_dispatch_outbox` rows moved to the terminal `'POISONED'` status by
   * `RewardTrackingOutboxRepository.recordPreDispatchFailure`. One of this task's own two
   * operator-audit mechanisms (the other is `findPoisoned()`); see that repository's own header
   * for why an admin endpoint was left out of this task's scope.
   */
  private poisonedOutboxRowCount = 0;

  /** Increment `reward_tracking_dispatch_tier_total{tier}` — call only on a genuinely successful
   * dispatch (implementation note 7), never on a failure path. */
  incrementDispatchTier(tier: DispatchTier): void {
    this.counts.set(tier, (this.counts.get(tier) ?? 0) + 1);
  }

  /** Test/observability accessor — the current count for one tier label, `0` if never
   * incremented. */
  getDispatchTierCount(tier: DispatchTier): number {
    return this.counts.get(tier) ?? 0;
  }

  /** T-INT-051. Call exactly once per row the very moment `recordPreDispatchFailure` reports
   * `poisoned: true` for it — never on every retried-but-not-yet-poisoned pre-dispatch failure. */
  incrementPoisonedOutboxRow(): void {
    this.poisonedOutboxRowCount += 1;
  }

  /** T-INT-051 TC-3. Test/observability accessor for the poisoned-row count above. */
  getPoisonedOutboxRowCount(): number {
    return this.poisonedOutboxRowCount;
  }
}
