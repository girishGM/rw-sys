/**
 * T-RAP-030. The two `activity_logs` queries the pending-row worker/stale-sweep need — the exact
 * claim query from `05-PROCESSING-PIPELINE.md` §4 (`FOR UPDATE SKIP LOCKED`), and the stale-row
 * reclaim query implementation note 3 describes. Neither statement needs an explicit
 * `BEGIN`/`COMMIT` from this repository: each is a single `UPDATE ... RETURNING` statement, which
 * Postgres already runs as one atomic unit on its own (same reasoning
 * `activity-logs.repository.ts`'s own header gives for its single multi-row `INSERT`).
 *
 * Owns its own runtime Postgres connection (the least-privilege `rap_app` role,
 * `AGENT-PROTOCOL.md` R1) rather than importing `ActivityMappingModule` for its own exported
 * `ACTIVITY_MAPPING_SEQUELIZE` — same self-contained-connection precedent every prior module in
 * this service has followed (`activity-logs.repository.ts`, `service-config.repository.ts`, ...)
 * for the same reason: this task's own `Depends on` is T-RAP-021/T-RAP-013, not a load-order
 * coupling to either module's own connection lifecycle.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type { ActivityLogRow } from '@/database/models/activity-log.model';

/** DI token for this module's own runtime Postgres connection — see this file's own header. */
export const PROCESSING_SEQUELIZE = Symbol('PROCESSING_SEQUELIZE');

/**
 * T-INT-044. An optional, additive restriction on which `tenant_id`s `claimNextPendingRow()` may
 * return — used ONLY by this codebase's own test callers (see that method's own doc comment for
 * why production code must never pass one). Expressed as an inclusive range rather than a single
 * id purely so a caller that deliberately owns more than one tenant id in the same test run (rare,
 * but not impossible) isn't forced to make several separate calls — every real call site today
 * happens to set `tenantIdRangeStart === tenantIdRangeEnd` (a single-tenant "range").
 */
export interface ClaimScope {
  tenantIdRangeStart: number;
  tenantIdRangeEnd: number;
}

@Injectable()
export class ActivityLogClaimRepository {
  constructor(@Inject(PROCESSING_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * `05-PROCESSING-PIPELINE.md` §4's own claim query: one `pending` row, ordered by
   * `activity_reached_date`, `FOR UPDATE SKIP LOCKED` so a row already claimed by a concurrent
   * caller (this process or another instance entirely) is simply invisible to this query rather
   * than blocked-and-retried — what makes TC-1 (two workers, ten rows, no double-claim) hold.
   * Flips the claimed row to `processing` in the same statement. Returns `null` for an empty
   * queue (TC-3), never throws for "nothing to claim".
   *
   * **T-INT-044: the optional `scope` parameter.** Omitted (or `undefined`), this method's SQL is
   * byte-for-byte the same genuinely-global "any pending row, any tenant" query
   * `05-PROCESSING-PIPELINE.md` §4 requires and every real production caller relies on — this is
   * the ONLY behavior a caller that omits `scope` can ever observe; adding this parameter changed
   * no existing caller's behavior. When a **test** caller does pass one, the SQL adds a hard
   * `tenant_id BETWEEN ... AND ...` predicate to both the inner `SELECT ... FOR UPDATE SKIP
   * LOCKED` and (defensively, though the inner clause already guarantees it) the outer `WHERE`, so
   * a row outside the given range is never even a candidate — not filtered out of an already-claimed
   * result after the fact, which would still have (invisibly) locked and flipped a foreign row to
   * `processing` before discarding it. This is what lets a test file construct a claim call that
   * structurally cannot observe, lock, or claim another concurrently-running test file's own rows
   * in the same real, shared `activity_logs` table, closing the cross-suite claim-contamination
   * hazard `T-INT-044`'s own task file documents at its source rather than requiring every new
   * caller to independently rediscover a give-back-loop mitigation. See
   * `test/modules/processing/claim-worker.spec.ts`'s own regression tests for the deterministic
   * proof that a disjoint range is a hard boundary, not merely an unlikely-to-cross one.
   */
  async claimNextPendingRow(scope?: ClaimScope): Promise<ActivityLogRow | null> {
    const tenantFilterSql = scope
      ? 'AND tenant_id BETWEEN :tenantIdRangeStart AND :tenantIdRangeEnd'
      : '';
    const rows = await this.sequelize.query<ActivityLogRow>(
      `UPDATE realtime_activity_processing.activity_logs
         SET status = 'processing', updated_at = now()
       WHERE id = (
         SELECT id FROM realtime_activity_processing.activity_logs
          WHERE status = 'pending'
          ${tenantFilterSql}
          ORDER BY activity_reached_date
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       ${tenantFilterSql}
       RETURNING *`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tenantIdRangeStart: scope?.tenantIdRangeStart ?? null,
          tenantIdRangeEnd: scope?.tenantIdRangeEnd ?? null,
        },
      },
    );
    return rows[0] ?? null;
  }

  /**
   * Implementation note 3: a row stuck in `processing` for longer than `timeoutSeconds` (a worker
   * crash mid-transaction, between this repository's own claim above and whatever transaction
   * T-RAP-031 onward opens for it) is reset back to `pending`, re-claimable by the next `SKIP
   * LOCKED` pass. Returns the count of rows actually reclaimed (TC-2's own assertion surface),
   * `0` for "nothing stale" — never a query for zero rows to update, the `WHERE` clause already
   * makes an all-fresh table a cheap no-op statement.
   */
  async sweepStaleProcessingRows(timeoutSeconds: number): Promise<number> {
    const rows = await this.sequelize.query<{ id: string }>(
      `UPDATE realtime_activity_processing.activity_logs
         SET status = 'pending', updated_at = now()
       WHERE status = 'processing'
         AND updated_at < now() - make_interval(secs => :timeoutSeconds)
       RETURNING id`,
      { type: QueryTypes.SELECT, replacements: { timeoutSeconds } },
    );
    return rows.length;
  }
}
