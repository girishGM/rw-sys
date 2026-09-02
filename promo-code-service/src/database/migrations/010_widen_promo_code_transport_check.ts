import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-PC-057 — widens `promo_code.promo_code.transport`'s `CHECK` constraint (migration 004) to
 * also allow `'REST'`, alongside the existing `'KAFKA'`/`'GRPC'`. T-PC-056 (REST generate
 * endpoint, `agent-promo-generation`) needs to persist `transport = 'REST'` on rows created via
 * the new REST adapter, but that CHECK — `transport varchar(10) NOT NULL CHECK (transport IN
 * ('KAFKA','GRPC'))` — rejects it today (defect evidence in this task's own task file).
 *
 * A new migration, never an edit to 004 — that migration is already applied in every environment
 * this service has run in (same "already applied everywhere" convention 009's own header
 * documents, and the same reason 009 added new `ALTER COLUMN` statements rather than touching
 * 002/003/004/006 directly).
 *
 * Postgres auto-names an inline, unnamed `CHECK` constraint `<table>_<column>_check` — confirmed
 * directly against the real local Postgres 16 server (`\d promo_code.promo_code` reports
 * `"promo_code_transport_check"`), not assumed — so `down()` can drop it by that exact name.
 */
const CONSTRAINT_NAME = 'promo_code_transport_check';

export async function up({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`ALTER TABLE promo_code.promo_code DROP CONSTRAINT ${CONSTRAINT_NAME};`, {
    type: QueryTypes.RAW,
  });
  await context.query(
    `ALTER TABLE promo_code.promo_code
       ADD CONSTRAINT ${CONSTRAINT_NAME} CHECK (transport IN ('KAFKA','GRPC','REST'));`,
    { type: QueryTypes.RAW },
  );
}

/**
 * Narrows the CHECK back to `('KAFKA','GRPC')`. **Not safe in general** — if any `'REST'` row
 * already exists, re-adding the narrower constraint fails loudly (Postgres validates existing
 * rows against a newly added `CHECK` by default) rather than silently orphaning data, same
 * caveat 009's own `down()` documents for its analogous widen. Rolling back after T-PC-056 has
 * shipped and real `'REST'` rows exist requires cleaning those rows up (or re-mapping their
 * transport) first — this `down()` does not attempt that for the caller.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`ALTER TABLE promo_code.promo_code DROP CONSTRAINT ${CONSTRAINT_NAME};`, {
    type: QueryTypes.RAW,
  });
  await context.query(
    `ALTER TABLE promo_code.promo_code
       ADD CONSTRAINT ${CONSTRAINT_NAME} CHECK (transport IN ('KAFKA','GRPC'));`,
    { type: QueryTypes.RAW },
  );
}
