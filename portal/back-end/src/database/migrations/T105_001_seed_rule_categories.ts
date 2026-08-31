import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-105 — seeds the two new rule categories (`COMPONENT`, `AGGREGATE`) and their sub-categories,
 * needed by the sample rules `T105_002` creates. `TRANSACTION`/`PRODUCT`/`SCHEDULE`/`USER`/
 * `MERCHANT` already exist (confirmed live before writing this: ids 13/14/15/16/21, all
 * `tenant_id=1`) — this migration reuses the existing `SCHEDULE`(15) category for the one
 * schedule-side sub-category rather than creating a duplicate, since `uq_rc_tenant_code
 * (tenant_id, category_code)` would reject a second `SCHEDULE` row outright.
 *
 * `tenant_id=1` matches the existing convention exactly. Confirmed by reading
 * `rules.service.ts#listCategories`/`#listSubCategories` directly: both call
 * `this.scoped.listAll(...)` with **no tenant filter** — `tenant_id` is a `NOT NULL` DB
 * technicality here, not a real per-tenant read scope, so this is not a per-tenant seed that
 * needs repeating for the other 40 tenants in this database.
 *
 * `WHERE NOT EXISTS` guards make both inserts idempotent on a second `db:migrate` run.
 *
 * **T-156 addendum.** On every environment this migration had actually run against before
 * T-156, `reward_config.tenants` already held a `tenant_id=1` row — real, pre-existing data
 * from the underlying corporate system this schema was translated from (see `T004_006`'s own
 * header and `CLAUDE.md`'s CC-00 finding), not anything a migration created. `fk_rc_tenant`
 * (`rule_categories.tenant_id → tenants.id`) therefore never fired on any environment this was
 * verified against — until T-057/T-152 exercised a genuinely fresh scratch database (schema.sql
 * + migrations, no other seed), where no `tenants` row exists at all and this insert fails
 * `fk_rc_tenant` outright (T-156's reproduced defect). `reward_config.rule_categories.tenant_id`
 * is `NOT NULL` with no `T002_009`-style relaxation authorised for it (R1 permits exactly two
 * named `DROP NOT NULL`s, neither of which is this column) — making it nullable is not this
 * task's decision to make unilaterally. The fix instead bootstraps the minimal `countries`/
 * `tenants` rows this FK needs, but **only when the schema is genuinely empty of tenants** —
 * `WHERE NOT EXISTS (SELECT 1 FROM reward_config.tenants)` — so a real environment (which
 * always already has a `tenant_id=1` row) never has this branch execute at all; it exists
 * purely so a from-scratch deploy (or this suite's own scratch database) has a valid FK target,
 * exactly the way a real first deploy would provision its first tenant before seeding anything
 * tenant-scoped. Both new rows land on `id=1` precisely because they are the first row inserted
 * into their respective (`generated always as identity`) tables — no `OVERRIDING SYSTEM VALUE`
 * needed, and no explicit id is ever asserted — which keeps every later migration's own
 * `tenant_id = 1` convention (`T105_002`, `T116_001`, `T118_001`, `T127_001`) satisfied without
 * changing any of them.
 *
 * **A second, deeper instance of the same defect class, found while proving the fix above end to
 * end.** This file's own comment two paragraphs up says `SCHEDULE` "already exist[s]" (id 15,
 * live) and deliberately reuses it rather than re-creating it — true on every environment this
 * ran against before T-156, but, like `tenants`, not true on a genuinely fresh database: no
 * migration anywhere creates a `SCHEDULE` `rule_categories` row either. Left alone, the
 * `rule_sub_categories` INSERT below silently drops its `SCHEDULE`/`TIME_WINDOW_CHECK` row on a
 * from-scratch run — the `JOIN … ON c.category_code = 'SCHEDULE'` simply matches nothing, no
 * error, 5 of this migration's own 6 declared sub-categories land instead of 6 (reproduced: see
 * this task's regression test). Bootstrapped the same way, and just as narrowly: only for the
 * `T156-BOOTSTRAP` tenant this file itself just created, so it is exactly as inert as the
 * `tenants`/`countries` bootstrap above on every environment that already has a real `SCHEDULE`
 * category. `TRANSACTION`/`PRODUCT`/`USER`/`MERCHANT` (the other four categories that comment
 * names) are **not** bootstrapped here — nothing in this file reads them, only `SCHEDULE` is a
 * true dependency of code this task owns; `T105_002` (owned by a different, already-`done` task)
 * separately assumes `TRANSACTION`/`GENERAL` exists and has its own, still-open gap on a fresh
 * database (filed separately — see this task's completion report, not fixed here per R9).
 *
 * **Why `COMPONENT`/`AGGREGATE`/`SCHEDULE` below resolve their tenant id via `TARGET_TENANT_ID_SQL`
 * rather than the literal `1` the pre-T-156 code used.** Caught by this task's own
 * `migrate → rollback → migrate` proof (R7), not by inspection: `reward_config.tenants.id` is
 * `generated always as identity`, and Postgres identity sequences are **not** rewound by
 * `DELETE` — only by `TRUNCATE ... RESTART IDENTITY`, which this migration's own `down()` (a
 * plain `DELETE`, deliberately, so other rows are never touched) does not use. A first
 * `up()`/`down()`/`up()` cycle on a fresh database therefore bootstraps a tenant at `id=1`, then
 * `down()` deletes it, then the second `up()` bootstraps a *new* tenant row whose identity value
 * is whatever the sequence next produces — `2`, not `1` — because the sequence itself was never
 * reset. A literal `tenant_id = 1` would silently stop matching that second-generation bootstrap
 * tenant (reproduced live during this task's own verification: see its completion report).
 * `TARGET_TENANT_ID_SQL` instead resolves "the tenant id `COMPONENT`/`AGGREGATE`/`SCHEDULE`
 * belong to" dynamically — a real environment's actual `id=1` row if one exists (unchanged
 * behaviour), else whichever id this file's own bootstrap tenant (matched by its `code`, never
 * by an assumed id) actually received.
 */
const TARGET_TENANT_ID_SQL =
  "(SELECT id FROM reward_config.tenants WHERE id = 1 OR code = 'T156-BOOTSTRAP' LIMIT 1)";

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    // T-156: bootstrap the minimal tenant (+ its required country) a from-scratch database has
    // no other way of obtaining, strictly guarded to a schema with zero tenants so this never
    // touches an environment that already has real tenant data (every one, prior to T-156).
    await context.query(
      `INSERT INTO reward_config.countries
           (code, name, timezone, currency_code, dialing_code, is_hq, status)
       SELECT 'ZZ', 'T-156 Bootstrap Country', 'UTC', 'USD', '+1', true, 'active'
       WHERE NOT EXISTS (SELECT 1 FROM reward_config.tenants)
         AND NOT EXISTS (SELECT 1 FROM reward_config.countries WHERE code = 'ZZ');`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `INSERT INTO reward_config.tenants (code, name, country_id, status)
       SELECT 'T156-BOOTSTRAP', 'T-156 Bootstrap Tenant', c.id, 'active'
       FROM reward_config.countries c
       WHERE c.code = 'ZZ'
         AND NOT EXISTS (SELECT 1 FROM reward_config.tenants)
         AND NOT EXISTS (SELECT 1 FROM reward_config.tenants WHERE code = 'T156-BOOTSTRAP');`,
      { type: QueryTypes.RAW, transaction: t },
    );
    // T-156: the `SCHEDULE` category this migration's own `TIME_WINDOW_CHECK` sub-category
    // insert below joins against — scoped to the bootstrap tenant only, see the file header.
    await context.query(
      `INSERT INTO reward_config.rule_categories (tenant_id, category_code, name, status)
       SELECT tn.id, 'SCHEDULE', 'Schedule', 'active'
       FROM reward_config.tenants tn
       WHERE tn.code = 'T156-BOOTSTRAP'
         AND NOT EXISTS (
           SELECT 1 FROM reward_config.rule_categories WHERE tenant_id = tn.id AND category_code = 'SCHEDULE'
         );`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `INSERT INTO reward_config.rule_categories (tenant_id, category_code, name, status)
       SELECT ${TARGET_TENANT_ID_SQL}, v.code, v.name, 'active'
       FROM (VALUES ('COMPONENT','COMPONENT'), ('AGGREGATE','AGGREGATE')) AS v(code, name)
       WHERE NOT EXISTS (
         SELECT 1 FROM reward_config.rule_categories
         WHERE tenant_id = ${TARGET_TENANT_ID_SQL} AND category_code = v.code
       );`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `INSERT INTO reward_config.rule_sub_categories (category_id, sub_category_code, name, status)
       SELECT c.id, v.sub_code, v.sub_name, 'active'
       FROM (VALUES
         ('COMPONENT','COMP_STATUS_CHECK','Sibling Component Status'),
         ('COMPONENT','COMP_DURATION_CHECK','Sibling Component Duration'),
         ('COMPONENT','COMP_COUNT_CHECK','Component Completion Count'),
         ('AGGREGATE','TXN_COUNT_CHECK','Transaction Count Aggregate'),
         ('AGGREGATE','TXN_SUM_CHECK','Transaction Sum Aggregate'),
         ('SCHEDULE','TIME_WINDOW_CHECK','Transaction Time Window')
       ) AS v(cat_code, sub_code, sub_name)
       JOIN reward_config.rule_categories c
         ON c.category_code = v.cat_code AND c.tenant_id = ${TARGET_TENANT_ID_SQL}
       WHERE NOT EXISTS (
         SELECT 1 FROM reward_config.rule_sub_categories
         WHERE category_id = c.id AND sub_category_code = v.sub_code
       );`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** Removes only the rows this migration added — the pre-existing `SCHEDULE` category and its
 * `GENERAL` sub-category are never touched, only additionally read via JOIN.
 *
 * **T-156 addendum.** Also removes the bootstrap `tenants`/`countries` rows from `up()`, but
 * only by their exact marker (`code = 'T156-BOOTSTRAP'` / `'ZZ'`) — a real environment never has
 * a row matching either code (its `up()` guard never inserts them there in the first place), so
 * this `DELETE` is a no-op everywhere except the from-scratch scenario that created them. Ordered
 * after the category/sub-category deletes above so `fk_rc_tenant` never sees a dangling
 * reference mid-rollback. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `DELETE FROM reward_config.rule_sub_categories
       WHERE sub_category_code IN (
         'COMP_STATUS_CHECK','COMP_DURATION_CHECK','COMP_COUNT_CHECK',
         'TXN_COUNT_CHECK','TXN_SUM_CHECK','TIME_WINDOW_CHECK'
       );`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `DELETE FROM reward_config.rule_categories
       WHERE tenant_id = ${TARGET_TENANT_ID_SQL} AND category_code IN ('COMPONENT','AGGREGATE');`,
      { type: QueryTypes.RAW, transaction: t },
    );
    // T-156: the bootstrap `SCHEDULE` category — matched by belonging to the bootstrap tenant,
    // never the live environment's real `SCHEDULE` row (a different tenant_id, so never touched).
    await context.query(
      `DELETE FROM reward_config.rule_categories
       WHERE category_code = 'SCHEDULE'
         AND tenant_id = (SELECT id FROM reward_config.tenants WHERE code = 'T156-BOOTSTRAP');`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(`DELETE FROM reward_config.tenants WHERE code = 'T156-BOOTSTRAP';`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await context.query(`DELETE FROM reward_config.countries WHERE code = 'ZZ';`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
