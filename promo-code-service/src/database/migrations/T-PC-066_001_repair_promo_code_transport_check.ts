import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-PC-066 — repairs a real drift found in the local dev DB: `promo_code.migrations` records
 * `010_widen_promo_code_transport_check.ts` as applied, but `promo_code.promo_code` had **no**
 * `promo_code_transport_check` CHECK constraint at all — not the widened one 010's `up()` adds,
 * not even the original narrow one from migration 004. Root-caused live (see this task's
 * completion report for the full trail): 010's own SQL, run start-to-finish, always leaves the
 * widened constraint in place — the only way to reach "constraint entirely absent, but 010 still
 * recorded applied" is an out-of-band `DROP CONSTRAINT` issued directly against Postgres (most
 * plausibly during T-PC-057's own regression proof, which its test file comment says was done by
 * "reverting migration 010" to get TC-4 red — if that revert was a raw `DROP CONSTRAINT` rather
 * than `migrator.down()`, the bookkeeping row for 010 would never have been touched, exactly
 * matching what was found), never followed by the matching `ADD CONSTRAINT` to restore it.
 *
 * **A new migration, never an edit to 010** — same "already applied everywhere" convention 009's
 * and 010's own headers both already establish, and doubly true here: even if 010's own SQL were
 * edited, Umzug would never re-run a migration it already has a bookkeeping row for, so an edit to
 * 010 could not, by itself, repair a single already-migrated environment (this one, or any other
 * that drifted the same way). This migration's `up()` is written defensively (`DROP CONSTRAINT IF
 * EXISTS`) so it repairs the exact reported state (constraint missing) *and* remains a safe no-op
 * to re-run against a healthy one (constraint already correct) — i.e. it doubles as a standing
 * guard against this exact class of drift recurring, not just a one-time patch.
 */
const CONSTRAINT_NAME = 'promo_code_transport_check';
const WIDENED_CHECK_SQL = `CHECK (transport IN ('KAFKA','GRPC','REST'))`;

export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE promo_code.promo_code DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME};`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `ALTER TABLE promo_code.promo_code ADD CONSTRAINT ${CONSTRAINT_NAME} ${WIDENED_CHECK_SQL};`,
    { type: QueryTypes.RAW },
  );
}

/**
 * Deliberately **not** a narrow-back to `('KAFKA','GRPC')` — unlike a normal schema migration,
 * this one's whole purpose is asserting an invariant ("the widened CHECK from T-PC-057 exists"),
 * not introducing a value that a rollback should retract; `'REST'` remains a permanent, intended
 * transport per T-PC-057/T-PC-056, not something being undone. Narrowing would also be actively
 * unsafe to run for real here: this table already holds real `'REST'` rows (confirmed live,
 * `agent-promo-generation`'s REST endpoint, T-PC-056), and Postgres validates every existing row
 * against a newly added CHECK — exactly the documented caveat on 010's own `down()`. Re-running
 * the same idempotent repair keeps `down()` genuinely "working" (R6: it completes without error
 * and leaves a valid, spec-compliant schema) rather than reproducing the drift this task exists
 * to fix, or throwing for real against live data during the `migrate → rollback → migrate` gate.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(
    `ALTER TABLE promo_code.promo_code DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME};`,
    { type: QueryTypes.RAW },
  );
  await context.query(
    `ALTER TABLE promo_code.promo_code ADD CONSTRAINT ${CONSTRAINT_NAME} ${WIDENED_CHECK_SQL};`,
    { type: QueryTypes.RAW },
  );
}
