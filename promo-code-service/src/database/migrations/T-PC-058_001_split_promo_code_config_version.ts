import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-PC-059 — implements the schema half of T-PC-058's "split identity from versioned payout"
 * design (that task file's own SQL block). Filed here, not under `agent-promo-config` (the
 * owner of T-PC-058 itself), because every migration file and `test/database/**` spec is
 * exclusively granted to `agent-promo-foundation` in `project.config.json` — see this task's own
 * task file (`T-PC-059-split-promo-code-config-into-identity.md`) for the full defect chain.
 *
 * Splits `promo_code_config` into:
 *  - the enduring identity (`tenant_id`/`merchant_id`/`name`/`status` — the thing a Maker picks
 *    by name), trimmed of every payout-specific column, all of which move to a new
 *    `promo_code_config_version` row.
 *  - `promo_code_config_version` — one row per version, versioned exactly like
 *    `reward_config.reward_versions` (`version_no`, `draft|published|deprecated|retired`,
 *    `supersedes_version_id`, publish timestamps). The DB immutability/undeletability trigger for
 *    this table is added separately by migration `_002` — kept as its own file/migration, per
 *    that file's own "Files owned" split in the task file.
 *
 * **Backfill** (T-PC-058 Implementation note 1): every existing `promo_code_config` row becomes
 * exactly one `version_no = 1`, `status = 'published'` version row, carrying its current payout
 * columns forward verbatim (`published_at = updated_at`, `published_by = updated_by`) — lossless,
 * since only one "version" has ever existed for any config until now. Nothing about any
 * already-issued `promo_code` row changes — its own value snapshot is untouched either way
 * (`01-DATABASE.md` §3's existing note).
 *
 * **Deviation, flagged for the completion report**: `updated_by` deliberately stays on the
 * identity table, not moved to the version table. T-PC-058's own Objective prose enumerates
 * exactly which columns move ("code_prefix/postfix/length/character_set/
 * exclude_ambiguous_chars/reward_value_type/reward_value/reward_unit/max_redemptions_per_code/
 * code_expiry_days all MOVE to the version table") and `updated_by` is not one of them; its own
 * illustrative `CREATE TABLE` block for the trimmed identity table simply omits every column it
 * isn't specifically calling out as moved or kept, rather than issuing a second, contradictory
 * instruction to drop `updated_by` — reading it as an oversight in the illustrative block, not a
 * second instruction, is also the more conservative choice (identity-level edits — rename,
 * archive — still have an actor worth recording). Not treated as a self-contradicting design doc
 * requiring escalation (AGENT-PROTOCOL.md §3/§7) — it's a single omitted column in an
 * illustrative snippet, not two instructions that actually conflict.
 *
 * Wrapped in one transaction (unlike migrations 002-010 in this chain, which are simple
 * single-statement changes) — this migration drops live columns after moving their data, on a
 * table `campaign_promo_config`/`promo_code` already reference, so a partial failure must not be
 * allowed to leave the identity table trimmed without every row's data safely captured in its own
 * version row first. Mirrors the portal's own precedent for exactly this risk level
 * (`portal/back-end/src/database/migrations/T005_007_immutability_triggers.ts`).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `CREATE TABLE promo_code.promo_code_config_version (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        promo_code_config_id  uuid NOT NULL REFERENCES promo_code.promo_code_config(id),
        version_no            int  NOT NULL,
        code_prefix           varchar(10) NULL,
        code_postfix          varchar(10) NULL,
        code_length           smallint NOT NULL CHECK (code_length BETWEEN 4 AND 32),
        character_set         varchar(20) NOT NULL
                                 CHECK (character_set IN ('NUMERIC','ALPHA','ALPHANUMERIC')),
        exclude_ambiguous_chars boolean NOT NULL DEFAULT true,
        reward_value_type     varchar(20) NOT NULL
                                 CHECK (reward_value_type IN ('FIXED_AMOUNT','PERCENTAGE','POINTS')),
        reward_value          decimal(18,4) NOT NULL,
        reward_unit           varchar(10) NOT NULL,
        max_redemptions_per_code smallint NOT NULL DEFAULT 1,
        code_expiry_days      integer NULL,
        status                varchar(20) NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft','published','deprecated','retired')),
        supersedes_version_id uuid NULL REFERENCES promo_code.promo_code_config_version(id),
        created_by            varchar(64) NOT NULL,
        created_at            timestamptz NOT NULL DEFAULT now(),
        published_by          varchar(64) NULL,
        published_at          timestamptz NULL,
        deprecated_at         timestamptz NULL,
        retired_at            timestamptz NULL,
        updated_at            timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_pccv_config_version UNIQUE (promo_code_config_id, version_no),
        CONSTRAINT ck_pccv_published_fields
            CHECK (status = 'draft' OR (published_at IS NOT NULL AND published_by IS NOT NULL))
      );`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE UNIQUE INDEX uq_pccv_one_draft
         ON promo_code.promo_code_config_version (promo_code_config_id) WHERE status = 'draft';`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `CREATE INDEX ix_pccv_config_status
         ON promo_code.promo_code_config_version (promo_code_config_id, status);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // Backfill — one published version_no=1 row per existing config, carrying its current
    // payout columns forward verbatim. Must run before the DROP COLUMN below, while the source
    // columns still exist.
    await context.query(
      `INSERT INTO promo_code.promo_code_config_version
         (promo_code_config_id, version_no, code_prefix, code_postfix, code_length,
          character_set, exclude_ambiguous_chars, reward_value_type, reward_value, reward_unit,
          max_redemptions_per_code, code_expiry_days, status, created_by, created_at,
          published_by, published_at, updated_at)
       SELECT id, 1, code_prefix, code_postfix, code_length, character_set,
              exclude_ambiguous_chars, reward_value_type, reward_value, reward_unit,
              max_redemptions_per_code, code_expiry_days, 'published', created_by, created_at,
              updated_by, updated_at, updated_at
         FROM promo_code.promo_code_config;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // Trim the identity table down to the enduring columns — every payout column now lives
    // exclusively on promo_code_config_version. Dropping these columns also drops the CHECK
    // constraints that referenced only them (code_length/character_set/reward_value_type) —
    // recreated on the version table above, restored by down() below if rolled back.
    await context.query(
      `ALTER TABLE promo_code.promo_code_config
         DROP COLUMN code_prefix,
         DROP COLUMN code_postfix,
         DROP COLUMN code_length,
         DROP COLUMN character_set,
         DROP COLUMN exclude_ambiguous_chars,
         DROP COLUMN reward_value_type,
         DROP COLUMN reward_value,
         DROP COLUMN reward_unit,
         DROP COLUMN max_redemptions_per_code,
         DROP COLUMN code_expiry_days;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Restores the identity table's dropped columns and repopulates them from each config's own
 * "best" version — the currently `published` one if any, else its highest `version_no` — then
 * drops the version table. Symmetric and lossless immediately after a fresh `up()` (exactly one
 * `version_no=1` published row per config, so there is only ever one candidate). **Lossy** if run
 * after real multi-version history has accumulated (task file "Rollback" section: rolling back
 * only removes the new version-tracking machinery — there is nowhere on the trimmed single-row
 * identity shape to put more than one version's worth of history back).
 *
 * If a config somehow has zero version rows at rollback time (should never happen — backfill
 * above guarantees at least one, and every row created after `up()` is expected to go through a
 * version), the `SET NOT NULL` below fails loudly rather than silently leaving nulls in
 * previously-NOT-NULL columns — consistent with this schema's existing "fail loudly on an
 * unexpected state" convention (`003_create_campaign_promo_config.ts`'s own comment on
 * `ON DELETE` defaults).
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE promo_code.promo_code_config
         ADD COLUMN code_prefix varchar(10) NULL,
         ADD COLUMN code_postfix varchar(10) NULL,
         ADD COLUMN code_length smallint NULL,
         ADD COLUMN character_set varchar(20) NULL,
         ADD COLUMN exclude_ambiguous_chars boolean NULL,
         ADD COLUMN reward_value_type varchar(20) NULL,
         ADD COLUMN reward_value decimal(18,4) NULL,
         ADD COLUMN reward_unit varchar(10) NULL,
         ADD COLUMN max_redemptions_per_code smallint NULL,
         ADD COLUMN code_expiry_days integer NULL;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `UPDATE promo_code.promo_code_config c
         SET code_prefix = v.code_prefix,
             code_postfix = v.code_postfix,
             code_length = v.code_length,
             character_set = v.character_set,
             exclude_ambiguous_chars = v.exclude_ambiguous_chars,
             reward_value_type = v.reward_value_type,
             reward_value = v.reward_value,
             reward_unit = v.reward_unit,
             max_redemptions_per_code = v.max_redemptions_per_code,
             code_expiry_days = v.code_expiry_days
         FROM (
           SELECT DISTINCT ON (promo_code_config_id) *
             FROM promo_code.promo_code_config_version
            ORDER BY promo_code_config_id, (status = 'published') DESC, version_no DESC
         ) v
        WHERE v.promo_code_config_id = c.id;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `ALTER TABLE promo_code.promo_code_config
         ALTER COLUMN code_length SET NOT NULL,
         ALTER COLUMN character_set SET NOT NULL,
         ALTER COLUMN exclude_ambiguous_chars SET NOT NULL,
         ALTER COLUMN exclude_ambiguous_chars SET DEFAULT true,
         ALTER COLUMN reward_value_type SET NOT NULL,
         ALTER COLUMN reward_value SET NOT NULL,
         ALTER COLUMN reward_unit SET NOT NULL,
         ALTER COLUMN max_redemptions_per_code SET NOT NULL,
         ALTER COLUMN max_redemptions_per_code SET DEFAULT 1;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `ALTER TABLE promo_code.promo_code_config
         ADD CONSTRAINT ck_promo_code_config_code_length
           CHECK (code_length BETWEEN 4 AND 32),
         ADD CONSTRAINT ck_promo_code_config_character_set
           CHECK (character_set IN ('NUMERIC','ALPHA','ALPHANUMERIC')),
         ADD CONSTRAINT ck_promo_code_config_reward_value_type
           CHECK (reward_value_type IN ('FIXED_AMOUNT','PERCENTAGE','POINTS'));`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query('DROP TABLE promo_code.promo_code_config_version;', {
      type: QueryTypes.RAW,
      transaction: t,
    });

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
