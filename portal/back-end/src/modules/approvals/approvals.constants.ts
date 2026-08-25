/**
 * T-038 — the fixed vocabularies and tuning constants `/approvals` works from.
 *
 * The status/action vocabularies themselves are **not** redeclared here: they are already
 * transcribed from `ck_par_status`/`ck_par_action` in `campaigns.constants.ts` (T-037), which
 * this module imports and re-exports below. Two transcriptions of one CHECK constraint is one
 * transcription too many — the second is the one that drifts.
 */
import {
  APPROVAL_ACTION_CREATE,
  APPROVAL_ENTITY_CAMPAIGN,
  APPROVAL_STATUS,
} from '@/modules/campaigns/campaigns.constants';

export { APPROVAL_ACTION_CREATE, APPROVAL_ENTITY_CAMPAIGN, APPROVAL_STATUS };

/**
 * `role_entity_permissions.entity` for the queue itself (T004_001's seed).
 *
 * The seed grants `checker` → `['view','approve','reject']` on this entity, and `view` alone to
 * `super_admin`/`country_admin`/`tenant_admin`/`maker`. `merchant` gets **no row at all**, which
 * is what makes TC-3 (*"`merchant` calls `/approvals` → 403"*) a property of the data rather than
 * of a branch somebody has to remember to write.
 */
export const APPROVAL_ENTITY = 'approval';

/**
 * The entity/action pair guarding `POST /approvals/:id/return`, and why it is not
 * `approval:return`.
 *
 * T004_001 seeds **no `return` action on the `approval` entity** — verified against the seed and
 * against the live table, not assumed. The only `return` grant that exists anywhere is
 * `checker → campaign:['view','approve','reject','return']`, and it is the semantically correct
 * one besides: returning a submission is an action on the *campaign* (it moves the campaign back
 * to the maker for rework), whereas approve/reject are decisions on the *request*.
 *
 * Adding an `approval:return` row would mean a new seed migration, and seed migrations live in
 * `back-end/src/database/migrations/**` — outside this task's `Files owned` (R9). Using the grant
 * that already exists needs no DDL, no seed and no coordination, and lands on exactly the right
 * role set: `checker` holds it, and `maker`, `tenant_admin`, `country_admin`, `super_admin` and
 * `merchant` all do not, so TC-17/TC-18's 403s hold for `return` exactly as they do for
 * `approve`. Flagged in the completion report.
 */
export const RETURN_ENTITY = 'campaign';
export const RETURN_ACTION = 'return';

/** 03-API-CONTRACT.md §1 — pagination is capped, not rejected, at 100 per page (TC-24). */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * How many distinct portal users one page of the queue may resolve display names for.
 *
 * A page is capped at {@link MAX_PAGE_SIZE} rows and each row names at most two users
 * (requester, reviewer), so this is never reached in practice; it exists so a future caller that
 * widens the page size cannot turn one queue read into an unbounded `IN (…)`.
 */
export const MAX_NAME_LOOKUPS = 2 * MAX_PAGE_SIZE;

/**
 * How often {@link ApprovalExpirySweeper} marks timed-out requests `expired`.
 *
 * Hourly, and the exact figure is deliberately uncritical: implementation note 5 requires that
 * *"any read of a stale row"* is treated as expired independently, so the sweeper only tidies the
 * stored value — it is never what makes the expiry correct. See `approvals.service.ts`.
 */
export const EXPIRY_SWEEP_CRON = '0 * * * *';

/** The three decisions, as the audit trail and the notification copy name them. */
export const APPROVAL_DECISION = Object.freeze({
  APPROVE: 'approve',
  REJECT: 'reject',
  RETURN: 'return',
} as const);

export type ApprovalDecision = (typeof APPROVAL_DECISION)[keyof typeof APPROVAL_DECISION];
