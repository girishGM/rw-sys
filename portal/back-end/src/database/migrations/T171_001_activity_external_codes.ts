import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_portal.activity_external_codes` — T-171. The external/transaction-type codes an
 * activity is *also* known by outside this portal.
 *
 * ### What it is for
 *
 * `realtime-activity-processing-service` (a standalone sibling project, its own plan folder)
 * receives activities that carry a `transactionType` and no `activityCode`, and has to resolve one
 * to the other before it can match anything
 * (`realtime-activity-processing-service-plan/05-PROCESSING-PIPELINE.md` §1). Nothing in this
 * portal could express that mapping. This table does, and `campaign_config.v1.proto`'s `Activity`
 * message carries it to that service over the existing T-047 read-only contract.
 *
 * ### Why `reward_portal` and not a column on `reward_config.activities`
 *
 * AGENT-PROTOCOL R1 forbids new DDL against `reward_config` outright — it is the frozen,
 * ported-from-MSSQL external reference schema. `reward_config.activities` is therefore not touched
 * by this migration at all. `activity_id` and `tenant_id` reference `reward_config.activities(id)`
 * and `reward_config.tenants(id)` **by value**, not by cross-schema foreign key: exactly the
 * precedent `T047_001` set for `grpc_service_grants`, and exactly what the requesting service's own
 * design doc asks for (`.../01-DATABASE.md` §2 — "a plain reference is simpler and avoids coupling
 * the two schemas' migration ordering").
 *
 * ### Why a join table and not a comma-separated column on `activities`
 *
 * One activity may be known by several external codes. A CSV column forces either
 * `ANY(string_to_array(...))` or application-side parsing on **every** inbound activity that
 * arrives by `transactionType`, at real-time ingestion volume. A join table keeps the consuming
 * lookup a plain indexed equality match. This was the deliberate choice over the CSV shape the
 * requirement originally floated (`.../04-CACHE-INVALIDATION.md` §4).
 *
 * ### Uniqueness is per tenant, not global — the one place this deviates from T-171's own DDL
 *
 * T-171's implementation note 1 sketches `UNIQUE (external_code)` and then, in the same note,
 * instructs: *"mirror whatever scoping `reward_config.activities.activity_code` itself uses (it's
 * unique per-tenant there, `uq_a_tenant_code`); if `transactionType` values can collide across
 * tenants in practice, escalate rather than guessing."* Those two halves disagree, and everything
 * else resolves the disagreement the same way:
 *
 *  - `reward_config.activities` is tenant-owned and its `activity_code` is unique **per tenant**,
 *    so an `activity_id` already implies a tenant; a globally-unique external code would let the
 *    first tenant to claim `"PURCHASE"` deny it to every other tenant in the deployment.
 *  - The consuming service's own mirror of this table is
 *    `UNIQUE (tenant_id, external_code)` and its design doc states the rule in words: *"one
 *    `external_code` maps to exactly one `activity_code` **per tenant**"*
 *    (`.../01-DATABASE.md` §2). A globally-unique portal table would be a strictly narrower
 *    contract than the consumer already assumes, and the mismatch would only ever surface as a
 *    failed insert in production.
 *
 * AGENT-PROTOCOL §3 ("if the task description conflicts with a design doc, the design doc wins;
 * note the conflict in your completion report") therefore decides it: `uc_activity_external_codes`
 * keys on `(tenant_id, external_code)`. Flagged in the T-171 completion report.
 *
 * `tenant_id` is stored on the row rather than joined through `activities` for two reasons: a
 * unique index cannot span a cross-schema subquery, and `ScopedRepository`'s tenancy predicate
 * (`scope-strategy.ts`) needs a real column to bind to.
 *
 * ### Grants
 *
 * `T002_008_grants` leaves `ALTER DEFAULT PRIVILEGES IN SCHEMA reward_portal GRANT ALL ON TABLES TO
 * reward_app` in place, so a new table here arrives with **every** privilege automatically — the
 * point `T048_001`'s header makes: *"the explicit GRANT + REVOKE pairs below are what make that
 * default safe."* The `GRANT` below is therefore a statement of intent (it is what the application
 * genuinely uses, and it survives the default being tightened later); the `REVOKE` is the part that
 * actually changes anything today.
 *
 * `DELETE` is kept, unlike on `grpc_service_grants`: this is reference data, not an access-control
 * record, it has no `status` column to soft-revoke through, and removing a stale `transactionType`
 * mapping is an ordinary administrative action. `TRUNCATE` is revoked — that is the privilege class
 * T-080 was filed about.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_portal.activity_external_codes (
          id            uuid         primary key default gen_random_uuid(),
          -- reward_config.tenants(id) BY VALUE — see this file's header, not a cross-schema FK.
          tenant_id     int          not null,
          -- reward_config.activities(id) BY VALUE — likewise.
          activity_id   int          not null,
          -- the transactionType value an external caller sends.
          external_code varchar(50)  not null,
          created_at    timestamptz  not null default now(),
          updated_at    timestamptz  not null default now(),

          constraint ck_aec_external_code check (length(btrim(external_code)) > 0)
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    // One `transactionType` must resolve to exactly one activity **within a tenant** — see the
    // header for why this is `(tenant_id, external_code)` and not `(external_code)` alone.
    await context.query(
      `CREATE UNIQUE INDEX uc_activity_external_codes
         ON reward_portal.activity_external_codes (tenant_id, external_code);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // The read shape `ConfigSnapshotBuilder` uses: every code for the activities of one campaign's
    // merchants, `WHERE activity_id IN (...)`.
    await context.query(
      `CREATE INDEX ix_activity_external_codes_activity
         ON reward_portal.activity_external_codes (activity_id);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON reward_portal.activity_external_codes TO reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `REVOKE TRUNCATE ON reward_portal.activity_external_codes FROM reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** R7 — a working `down()`. The table is portal-owned and nothing references it, so the drop is
 * unconditional; `CASCADE` removes both indexes with it. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(`DROP TABLE IF EXISTS reward_portal.activity_external_codes CASCADE;`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
