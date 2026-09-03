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

@Injectable()
export class ActivityLogClaimRepository {
  constructor(@Inject(PROCESSING_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * `05-PROCESSING-PIPELINE.md` §4's own claim query, verbatim: one `pending` row, ordered by
   * `activity_reached_date`, `FOR UPDATE SKIP LOCKED` so a row already claimed by a concurrent
   * caller (this process or another instance entirely) is simply invisible to this query rather
   * than blocked-and-retried — what makes TC-1 (two workers, ten rows, no double-claim) hold.
   * Flips the claimed row to `processing` in the same statement. Returns `null` for an empty
   * queue (TC-3), never throws for "nothing to claim".
   */
  async claimNextPendingRow(): Promise<ActivityLogRow | null> {
    const rows = await this.sequelize.query<ActivityLogRow>(
      `UPDATE realtime_activity_processing.activity_logs
         SET status = 'processing', updated_at = now()
       WHERE id = (
         SELECT id FROM realtime_activity_processing.activity_logs
          WHERE status = 'pending'
          ORDER BY activity_reached_date
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       RETURNING *`,
      { type: QueryTypes.SELECT },
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
