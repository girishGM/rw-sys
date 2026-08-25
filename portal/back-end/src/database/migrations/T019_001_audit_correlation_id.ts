import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-019 — `reward_portal.portal_audit_log.correlation_id`.
 *
 * 08-OBSERVABILITY.md §2 lists the audit tables among the stores the correlation id must reach:
 *
 * ```
 *   └─ every audit row            portal_audit_log.correlation_id
 *   └─ every domain audit row     campaign_audit_trail (via the audit service)
 * ```
 *
 * and §6's trace-retrieval endpoint (T-045) assembles its narrative *"from every store keyed by
 * `correlation_id`"*. This migration provides that key on the portal's own audit table.
 *
 * ### Only one of the two tables gets a column — AGENT-PROTOCOL R1
 *
 * This task's implementation note 8 says "add the column migrations for the audit **tables**",
 * plural. Only one of them can be done:
 *
 *  - `reward_portal.portal_audit_log` is the portal's own table. Column added here.
 *  - `reward_config.campaign_audit_trail` is **not ours**. R1: *"No DDL against `reward_config`
 *    except the two `DROP NOT NULL` statements in T-002. No new tables, no altered columns."* The
 *    live table (verified against `database/reward_config_postgres.sql` and the extracted DDL) has
 *    no `correlation_id` column and never had one.
 *
 * AGENT-PROTOCOL §7 names this exact case — *"a required column or table does not exist in
 * `reward_config`: do not create it"* — so it is escalated in the completion report rather than
 * created here. In the meantime `AuditService` carries the id into that table's existing
 * free-form `field_changes` JSON under a reserved key, which needs no DDL and is queryable
 * (`field_changes::jsonb ->> '__correlationId'`). See `audit.service.ts`.
 *
 * ### Why `varchar(64)` and no `CHECK`
 *
 * 64 is the upper bound of `^[A-Za-z0-9_-]{8,64}$` (08-OBSERVABILITY.md §1), the pattern
 * `CorrelationMiddleware` validates every id against before it is used for anything. The width is
 * therefore exact rather than generous. A `CHECK` re-stating the charset was considered and left
 * out: unlike T018_001's ciphertext-prefix constraint — which guards against a *future refactor*
 * writing the wrong kind of value — every writer of this column is `AuditRepository`, taking the
 * id from the validated trace context, and the failure this would catch (an unvalidated id) is
 * one the application cannot express. A constraint on a 7-year append-only table is not free.
 *
 * ### Nullable, deliberately
 *
 * Existing rows have no id, and audit rows are still written where no trace context exists at all
 * — a rejected refresh token, a CLI-driven bootstrap. `AuditService` must never fail a write
 * because tracing was unavailable (T-014 implementation note 4), so the column has to accept null.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE reward_portal.portal_audit_log
         ADD COLUMN IF NOT EXISTS correlation_id varchar(64) NULL;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // Partial: rows written outside a request carry NULL and are never searched by this key, so
    // indexing them would be paying for entries no query can use on the fastest-growing table in
    // the schema (08-OBSERVABILITY.md §7.1).
    await context.query(
      `CREATE INDEX IF NOT EXISTS ix_pal_correlation
         ON reward_portal.portal_audit_log(correlation_id)
       WHERE correlation_id IS NOT NULL;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `
      COMMENT ON COLUMN reward_portal.portal_audit_log.correlation_id IS
        'T-019. The 08-OBSERVABILITY.md §1 correlation id of the request that produced this row, '
        'validated against ^[A-Za-z0-9_-]{8,64}$ before use. NULL when the row was written '
        'outside a request. This is the key T-045''s GET /audit/trace/:correlationId joins on.';
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Drops the index, the comment and the column.
 *
 * Dropping the column loses the correlation ids already recorded, which is real data loss and is
 * the honest behaviour anyway: `down()` exists to return the schema to the state the previous
 * migration left it in (R7), and a `down` that kept the column would make
 * `migrate → rollback → migrate` non-idempotent. Nothing else reads the column — it is additive,
 * nullable, and no code path treats its absence as an error.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(`DROP INDEX IF EXISTS reward_portal.ix_pal_correlation;`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await context.query(
      `ALTER TABLE reward_portal.portal_audit_log DROP COLUMN IF EXISTS correlation_id;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
