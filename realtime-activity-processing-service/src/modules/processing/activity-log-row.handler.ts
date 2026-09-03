/**
 * T-RAP-030. The extension point `ActivityLogClaimWorker` hands each claimed row to — deliberately
 * the *only* thing this task wires the rule-evaluation/progress/budget/reward chain through
 * (Scope "Out": "the actual rule evaluation / progress update / reward logic a claimed row
 * triggers (T-RAP-031 onward) — this task's own tests use a stub handler to prove the claim
 * mechanism alone").
 *
 * T-RAP-031 (same owning agent, same directory scope) is expected to bind a real implementation
 * to `ACTIVITY_LOG_ROW_HANDLER` in `processing.module.ts` once it lands — see that file's own
 * header for why `ProcessingModule` binds a logging no-op here in the meantime rather than leaving
 * the token unbound.
 */
import type { ActivityLogRow } from '@/database/models/activity-log.model';

export interface ActivityLogRowHandler {
  /**
   * Handle one claimed (`status = 'processing'`) row. Whatever this does with the row's own
   * `status` transition (`processed`/`error`/left `processing` for the stale sweep to reclaim on
   * a thrown error) is entirely this handler's own concern, not `ActivityLogClaimWorker`'s —
   * `05-PROCESSING-PIPELINE.md` §5-§7 describes what a real handler (T-RAP-031 onward) does here.
   */
  handle(row: ActivityLogRow): Promise<void>;
}

/** DI token `ActivityLogClaimWorker` resolves its handler through — bound to a real
 * implementation from T-RAP-031 onward, to `NoopActivityLogRowHandler` (this file) until then. */
export const ACTIVITY_LOG_ROW_HANDLER = Symbol('ACTIVITY_LOG_ROW_HANDLER');
