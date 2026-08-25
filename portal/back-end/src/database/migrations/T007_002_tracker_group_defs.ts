import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_config.tracker_group_defs` — verbatim from 12-CAMPAIGN-STRUCTURE.md §1.4. What
 * the schema was missing: the pre-existing, now-portal-deprecated groups table (see the
 * header comment on `tracker-group-def.model.ts` for the full deprecation note) let you
 * *label* components into groups but stored nothing about how a group completes, so
 * grouping was only half-built (§1.2) — this table is the other half, added now
 * (T007_001's column) and left unused in v1 (Implementation notes §3; see also §1.5's
 * "Now / Later" table).
 *
 * Not wired into any evaluator yet — the runtime cannot evaluate two-level completion
 * until a later task builds it, and the wizard writes `group_code = NULL` throughout, so
 * no row in this table is ever referenced from live campaign data in v1. Its presence
 * documents the intended shape so the future change is additive, not a redesign.
 *
 * Evaluation order once wired up (§1.4, documented here — not enforced by any of these
 * constraints — for whoever implements the evaluator):
 *   1. Every component with `group_code IS NULL` evaluates directly against the tracker's
 *      own `completion_logic`.
 *   2. Every group evaluates by its own `completion_logic` here, producing one boolean.
 *   3. The tracker's `completion_logic` then applies over
 *      `{ungrouped components} UNION {group results}`.
 *   4. `is_mandatory` wins at both levels — a mandatory component or group is always
 *      required, regardless of what its containing logic would otherwise permit.
 *
 * `ck_tgd_logic` mirrors `trackers.ck_trk_logic` exactly — a group's completion logic is
 * the same three-value vocabulary as a tracker's. `ck_tgd_threshold` mirrors the intent of
 * `campaign_caps`'s own load-bearing CHECKs (T006_001): an `n_of` group with no threshold
 * is a configuration error, not data, and must be structurally impossible rather than
 * merely discouraged.
 *
 * This is a new table in `reward_config`, authorised by C1: new tables are allowed;
 * nothing existing is altered or dropped. The superseded groups table itself is left
 * fully in place and untouched (C1 forbids dropping it) — again, see
 * `tracker-group-def.model.ts`'s header comment.
 *
 * `reward_config` gets no `ALTER DEFAULT PRIVILEGES` (unlike `reward_portal` — see
 * `T002_008_grants.ts`'s own header, deliberately, for least-privilege reasons), so a brand
 * new table here starts with zero grants for `reward_app` unless one is added explicitly.
 * T-091 found this table (and 18 others across T002/T005/T006) shipped with exactly that
 * gap — `reward_app` could not read or write any of them at all, a live 500 the moment
 * anything tried. Fixed here, at creation time, granted directly in this table's own `up()`
 * rather than deferred to a later catch-all migration, matching `T037_002`/`T040_001`'s own
 * "grant (and, where needed, restrict) at the point the table is created" convention.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_config.tracker_group_defs (
          id                   int generated always as identity primary key,
          tracker_id           int          not null references reward_config.trackers(id),
          group_code           varchar(10)  not null,
          name                 varchar(100) null,
          completion_logic     varchar(10)  not null default 'all',
          completion_threshold int          null,
          sequence_order       int          not null default 1,
          is_mandatory         boolean      not null default false,
          created_at           timestamptz  not null default now(),
          updated_at           timestamptz  not null default now(),
          constraint uq_tgd unique (tracker_id, group_code),
          constraint ck_tgd_logic check (completion_logic in ('all','any','n_of')),
          constraint ck_tgd_threshold
              check (completion_logic <> 'n_of' or completion_threshold is not null)
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_tgd_tracker ON reward_config.tracker_group_defs(tracker_id);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // T-091: see this file's header — reward_config has no ALTER DEFAULT PRIVILEGES *of this
    // project's own making*, so this new table needs its own explicit grant or reward_app
    // can neither read nor write it at all. (No explicit REVOKE DELETE here — see
    // T002_008_grants.ts's own T-091 comment: this schema's pre-existing, out-of-project
    // default ACL already hands DELETE to every new table here regardless, and
    // T006_001_campaign_caps.ts's own test already pins that as accepted, relied-upon
    // behaviour rather than a leak this task should close unilaterally.)
    await context.query(
      `GRANT SELECT, INSERT, UPDATE ON reward_config.tracker_group_defs TO reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** `CASCADE` drops the index above along with the table; nothing else references this
 * table yet — `group_code` on `tracker_tracker_components` (T007_001) is a plain nullable
 * column, not a foreign key into this table, deliberately (§1.4's comment: the value is a
 * label, matched against `tracker_group_defs.group_code` by application logic once the
 * evaluator exists, not by a DB-enforced FK). */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query('DROP TABLE IF EXISTS reward_config.tracker_group_defs CASCADE;', {
    type: QueryTypes.RAW,
  });
}
