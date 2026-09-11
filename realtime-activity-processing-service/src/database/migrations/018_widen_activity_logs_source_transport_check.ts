import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-INT-054. `activity_logs.source_transport`'s own `CHECK` constraint (migration `004`) only ever
 * allowed `'KAFKA'`/`'GRPC'` — this task adds a third, real inbound transport (a REST option for
 * `SubmitActivity`, `src/rest/activity-ingest/`, built because provisioning a real mTLS CA/cert
 * chain for `test-app/tracking-service`'s own Render deployment was the more operationally costly
 * of this task's two options — see that task file's own "Recommendation"). Without this migration,
 * every REST-submitted activity's own `INSERT` (`ActivityLogsRepository.insertFanOutRows`) would
 * fail its `CHECK` constraint at the database layer, even though the application-level
 * `SourceTransport`/`ActivitySourceTransport` TypeScript types (this same task's own edit) already
 * accept `'REST'`.
 *
 * `ALTER TABLE ... DROP CONSTRAINT` + `ADD CONSTRAINT` (not `DROP COLUMN`/`re-CREATE TABLE`) is the
 * standard, minimal-risk way to widen a `CHECK` constraint on an existing Postgres table without
 * touching any existing row — every already-inserted `'KAFKA'`/`'GRPC'` row is untouched, and this
 * is safely re-runnable (`down` restores the original two-value constraint) for the
 * `db:migrate && db:rollback && db:migrate` gate cycle.
 *
 * **Retry 1/3 fix (review finding: "down is not transactional and breaks once a REST row
 * exists").** Both `up()` and `down()` now run their two statements inside a single
 * `context.transaction()`, matching the established pattern already used for every
 * multi-statement migration in `portal/back-end/src/database/migrations/*` (e.g.
 * `T128_001_portal_user_ui_theme.ts`), rather than two independent `context.query()` calls. The
 * original, non-transactional `down()` is genuinely broken the moment any `'REST'` row exists at
 * rollback time: statement 1 (`DROP CONSTRAINT`) always succeeds; statement 2 (`ADD CONSTRAINT ...
 * IN ('KAFKA','GRPC')`) then fails its own validation scan against that existing `'REST'` row —
 * but by then statement 1 has already committed on its own, so the table is left with **no**
 * `source_transport` CHECK constraint at all (not the original two-value one, not the widened
 * three-value one), silently reopening every future insert to any string. Wrapping both statements
 * in one transaction makes `down()` atomic: either both apply (table cleanly reverted to the
 * two-value constraint) or, on the same constraint-violation error, neither does (transaction rolls
 * back, table is left exactly as it was — still on the three-value constraint, `'REST'` ingestion
 * still fully working) — a clean, loud failure instead of a silently-broken table. This does not
 * make `down()` succeed while a `'REST'` row exists (that would require a data decision this
 * migration has no business making, e.g. deleting or remapping the row) — it makes the *failure
 * itself* safe rather than leaving corrupt schema state behind, which is the actual defect the
 * review caught. Operationally: if `down()` genuinely needs to run past a real `'REST'` row (not
 * the case for this task's own `db:migrate && db:rollback && db:migrate` gate cycle, which never
 * inserts one), the operator must first migrate that row's `source_transport` value or delete it —
 * exactly as true of the original migration `004`'s own two-value constraint against any then-
 * hypothetical third value.
 */
const CONSTRAINT_NAME = 'activity_logs_source_transport_check';

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE realtime_activity_processing.activity_logs
         DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME};`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `ALTER TABLE realtime_activity_processing.activity_logs
         ADD CONSTRAINT ${CONSTRAINT_NAME} CHECK (source_transport IN ('KAFKA','GRPC','REST'));`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  // Atomic: if the narrower CHECK can't be re-added (e.g. a real 'REST' row already exists), the
  // DROP is rolled back too — the table is left exactly as it was (three-value constraint intact,
  // REST ingestion still working) rather than orphaned with no CHECK constraint at all. See the
  // header comment above for the full incident this fixes.
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE realtime_activity_processing.activity_logs
         DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME};`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `ALTER TABLE realtime_activity_processing.activity_logs
         ADD CONSTRAINT ${CONSTRAINT_NAME} CHECK (source_transport IN ('KAFKA','GRPC'));`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
