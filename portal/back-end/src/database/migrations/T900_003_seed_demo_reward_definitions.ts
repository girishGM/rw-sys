import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Ad hoc demo-data seed, phase 2 of 3 (see `task/reset-reference-data-keep-users`; follows
 * `T900_002`'s country/tenant/merchant seed). Defines the 3 reward categories the user asked
 * for, at the Super Admin level, exactly as described in that conversation:
 *
 * 1. **Cashback** — a fixed-amount reward (`FIXED_AMOUNT`) whose currency and amount are left
 *    unset here; a Maker sets both when applying the reward to a campaign. That Maker-writable
 *    attach-time field did not exist in this codebase before this task — see
 *    `BindingsService.assertCashbackAttachable`/`writeCashbackAmount` (added alongside this
 *    migration) for the mechanism this reward now exercises.
 * 2. **Promo Code** (`PROMO_CODE`) — the Super Admin picks *which API assigns the code*
 *    (`value_config.apiProvider`) here, at creation time; the Maker picks the actual promo code
 *    config later, at any of the three attach levels (`value_config.bindLevels`). This one
 *    already worked end to end before this task (T-127) — seeded here to complete the trio, not
 *    to add behaviour.
 * 3. **Bank Points, "Stripe"** — a `POINTS` reward, likewise left unset here; a Maker sets the
 *    point count at attach time via the same new mechanism Cashback uses.
 *
 * ### Why every reward system here has `tenant_id = NULL`
 *
 * Mirrors `T105_002`'s own choice for its sample global rules: a Super-Admin-authored reward
 * definition, identical for every tenant, is exactly the shape `tenant_id IS NULL` exists for
 * (`uc_reward_system_code UNIQUE (tenant_id, system_code)` — Postgres treats `NULL` as distinct
 * from `NULL`, so this never collides with a future tenant-specific reward of the same code).
 * Each is assigned live to all 3 kept countries (`T900_002`'s `MY`/`SG`/`KH`), so any tenant's
 * campaign in any of them can offer all three once campaign-building starts (phase 3).
 *
 * ### Cashback's version carries no `unit_code` — a documented limitation, not an oversight
 *
 * A version's `unit_code` is meant to be one fixed value (`11-BUDGETS-AND-LIMITS.md §3.1`), but
 * this reward's currency is chosen per-attachment by whichever Maker applies it — there is no
 * single currency to name here. Leaving it `NULL` means step 5's worst-case payout line reads
 * "(unit not declared)" until a real currency is chosen, which is the honest answer; asserting a
 * fixed currency (e.g. `MYR`) would be actively wrong the first time a Maker attaches this
 * reward with `SGD`. Flagged for whoever owns budget analysis next, not silently worked around.
 *
 * ### Seeded `draft`, not `published` — same reasoning `T105_002` already established
 *
 * `fn_reward_version_undeletable` rejects `DELETE` on any non-`draft` row, exactly like the rule
 * side `T105_002` documents at length — its own conclusion applies verbatim here: seeding
 * `published` would make `down()` unable to genuinely reverse this migration (R7), and a
 * migration silently making a reward globally live with no human review step is not a decision a
 * migration should make unilaterally. Functionally this costs nothing in the demo either:
 * `activeRewardVersionsByReward()` (the function that decides which version is "live" for the
 * Kind-gating/attach flow) reads only the two country-assignment tables below, never
 * `reward_versions.status` — confirmed by reading its body before relying on it. A Super Admin
 * still explicitly publishes these from the portal UI when ready, the same as `T105_002`'s rules.
 *
 * ### The bootstrap `admin_users` row
 *
 * `T900_001`'s reset left `reward_config.admin_users` empty. `reward_versions.created_by`/
 * `published_by` and the two country-assignment tables' `assigned_by` are all plain `NOT NULL`
 * integers with **no** FK constraint (confirmed live via `pg_constraint` — unlike
 * `rule_master.created_by`, which does have one), so a literal placeholder would have worked;
 * bootstrapping a real row instead follows the same precedent `T105_002`'s own T-163 addendum
 * set, guarded identically (`NOT EXISTS (SELECT 1 FROM admin_users)`, so a real environment's
 * own admin data is never touched) and with its own distinct marker email so the two bootstrap
 * rows never collide if both migrations ever run against the same fresh database.
 */

const BOOTSTRAP_ADMIN_EMAIL = 'bootstrap-admin@t900.invalid';
const BOOTSTRAP_API_KEY_PREFIX = 'T900BOOT';

/** The 2 leftover e2e-fixture categories confirmed live (§ conversation) — not real taxonomy. */
const JUNK_CATEGORY_CODES = ['T118_CAT_1788011131934', 'T118_CAT_OTHER_1788011131936'];
const JUNK_SUB_CATEGORY_CODE = 'T118_SUB_1788011131935';

interface CategorySeed {
  categoryCode: string;
  categoryName: string;
  subCategoryCode: string;
  subCategoryName: string;
}

const NEW_CATEGORIES: readonly CategorySeed[] = [
  {
    categoryCode: 'CASHBACK',
    categoryName: 'Cashback',
    subCategoryCode: 'GENERAL',
    subCategoryName: 'General',
  },
  {
    categoryCode: 'POINTS',
    categoryName: 'Points',
    subCategoryCode: 'GENERAL',
    subCategoryName: 'General',
  },
];

interface RewardSeed {
  systemCode: string;
  name: string;
  description: string;
  rewardType: string;
  connectorType: string;
  categoryCode: string;
  subCategoryCode: string;
  rewardKind: 'FIXED_AMOUNT' | 'PROMO_CODE' | 'POINTS';
  valueConfig: Record<string, unknown> | null;
  unitType: 'currency' | 'points' | 'voucher' | null;
  unitCode: string | null;
  policyCode: string;
  policyName: string;
}

const REWARDS: readonly RewardSeed[] = [
  {
    systemCode: 'CASHBACK_SIGNUP',
    name: 'Signup Cashback',
    description: 'Fixed-amount cashback — currency and amount set by the Maker at attach time',
    rewardType: 'cashback',
    connectorType: 'WALLET_CREDIT',
    categoryCode: 'CASHBACK',
    subCategoryCode: 'GENERAL',
    rewardKind: 'FIXED_AMOUNT',
    valueConfig: null,
    unitType: 'currency',
    unitCode: null,
    policyCode: 'POL_CASHBACK_SIGNUP',
    policyName: 'Signup Cashback',
  },
  {
    systemCode: 'PROMO_VOUCHER',
    name: 'Promo Code Voucher',
    description:
      'Promo code issued via the configured provider; Maker picks the config at attach time',
    rewardType: 'voucher',
    // `connector_type` is `varchar(20)` — shortened from the full `PROMO_CODE_CONFIG_SERVICE`
    // provider code, which lives unabridged in `value_config.apiProvider` below instead (a
    // free-form `text` column with no length limit).
    connectorType: 'PROMO_CODE_SVC',
    categoryCode: 'VOUCHER',
    subCategoryCode: 'PROMO_CODE',
    rewardKind: 'PROMO_CODE',
    valueConfig: {
      apiProvider: 'PROMO_CODE_CONFIG_SERVICE',
      bindLevels: ['component', 'tracker', 'campaign'],
    },
    unitType: 'voucher',
    unitCode: null,
    policyCode: 'POL_PROMO_VOUCHER',
    policyName: 'Promo Code Voucher',
  },
  {
    systemCode: 'STRIPE_POINTS',
    name: 'Stripe Points',
    description: 'Bank points ("Stripe") — point count set by the Maker at attach time',
    rewardType: 'points',
    connectorType: 'POINTS_LEDGER',
    categoryCode: 'POINTS',
    subCategoryCode: 'GENERAL',
    rewardKind: 'POINTS',
    valueConfig: null,
    unitType: 'points',
    unitCode: 'PTS',
    policyCode: 'POL_STRIPE_POINTS',
    policyName: 'Stripe Points',
  },
];

const COUNTRY_CODES = ['MY', 'SG', 'KH'] as const;

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    // --- taxonomy cleanup + additions -----------------------------------------------------------
    await context.query(
      `DELETE FROM reward_config.reward_sub_categories WHERE sub_category_code = :code;`,
      { type: QueryTypes.RAW, transaction: t, replacements: { code: JUNK_SUB_CATEGORY_CODE } },
    );
    await context.query(
      `DELETE FROM reward_config.reward_categories WHERE category_code IN (:codes);`,
      { type: QueryTypes.RAW, transaction: t, replacements: { codes: JUNK_CATEGORY_CODES } },
    );

    for (const c of NEW_CATEGORIES) {
      await context.query(
        `INSERT INTO reward_config.reward_categories (tenant_id, category_code, name, status)
         SELECT 1, :categoryCode, :categoryName, 'active'
         WHERE NOT EXISTS (
           SELECT 1 FROM reward_config.reward_categories WHERE category_code = :categoryCode
         );`,
        { type: QueryTypes.RAW, transaction: t, replacements: { ...c } },
      );
      await context.query(
        `INSERT INTO reward_config.reward_sub_categories (category_id, sub_category_code, name)
         SELECT rc.id, :subCategoryCode, :subCategoryName
         FROM reward_config.reward_categories rc
         WHERE rc.category_code = :categoryCode
           AND NOT EXISTS (
             SELECT 1 FROM reward_config.reward_sub_categories
             WHERE category_id = rc.id AND sub_category_code = :subCategoryCode
           );`,
        { type: QueryTypes.RAW, transaction: t, replacements: { ...c } },
      );
    }

    // --- bootstrap admin_users (guarded — see file header) --------------------------------------
    await context.query(
      `INSERT INTO reward_config.tenant_api_keys (tenant_id, key_prefix, key_hash, status, expires_at)
       SELECT 1, :keyPrefix, 'bootstrap-placeholder-hash-not-a-real-key', 'active', now() + interval '100 years'
       WHERE NOT EXISTS (SELECT 1 FROM reward_config.admin_users)
         AND NOT EXISTS (SELECT 1 FROM reward_config.tenant_api_keys WHERE key_prefix = :keyPrefix);`,
      {
        type: QueryTypes.RAW,
        transaction: t,
        replacements: { keyPrefix: BOOTSTRAP_API_KEY_PREFIX },
      },
    );
    await context.query(
      `INSERT INTO reward_config.admin_users (api_key_id, role, display_name, email, status)
       SELECT k.id, 'super_admin', 'T-900 Bootstrap Admin', :email, 'active'
       FROM reward_config.tenant_api_keys k
       WHERE k.key_prefix = :keyPrefix
         AND NOT EXISTS (SELECT 1 FROM reward_config.admin_users)
         AND NOT EXISTS (SELECT 1 FROM reward_config.admin_users WHERE email = :email);`,
      {
        type: QueryTypes.RAW,
        transaction: t,
        replacements: { email: BOOTSTRAP_ADMIN_EMAIL, keyPrefix: BOOTSTRAP_API_KEY_PREFIX },
      },
    );
    const adminRows = (await context.query(
      `SELECT id FROM reward_config.admin_users ORDER BY id LIMIT 1;`,
      {
        type: QueryTypes.SELECT,
        transaction: t,
      },
    )) as Array<{ id: number }>;
    if (adminRows.length === 0) {
      throw new Error(
        'T900_003: no reward_config.admin_users row found to attribute reward seeds to.',
      );
    }
    const adminId = adminRows[0].id;

    // --- the 3 reward systems, versions, policies and country assignments -----------------------
    for (const reward of REWARDS) {
      const existing = (await context.query(
        `SELECT id FROM reward_config.reward_systems WHERE system_code = :systemCode AND tenant_id IS NULL;`,
        {
          type: QueryTypes.SELECT,
          transaction: t,
          replacements: { systemCode: reward.systemCode },
        },
      )) as Array<{ id: number }>;
      if (existing.length > 0) continue; // already seeded — idempotent re-run

      const [systemRows] = (await context.query(
        `INSERT INTO reward_config.reward_systems
           (tenant_id, system_code, name, description, reward_type, connector_type, status, category_id, sub_category_id)
         SELECT NULL, :systemCode, :name, :description, :rewardType, :connectorType, 'active', c.id, sc.id
         FROM reward_config.reward_categories c
         JOIN reward_config.reward_sub_categories sc
           ON sc.category_id = c.id AND sc.sub_category_code = :subCategoryCode
         WHERE c.category_code = :categoryCode
         RETURNING id;`,
        {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: {
            systemCode: reward.systemCode,
            name: reward.name,
            description: reward.description,
            rewardType: reward.rewardType,
            connectorType: reward.connectorType,
            categoryCode: reward.categoryCode,
            subCategoryCode: reward.subCategoryCode,
          },
        },
      )) as unknown as [Array<{ id: number }>];
      const rewardId = systemRows[0].id;

      const [versionRows] = (await context.query(
        `INSERT INTO reward_config.reward_versions
           (reward_id, version_no, status, reward_kind, value_config, unit_type, unit_code,
            created_by)
         VALUES
           (:rewardId, 1, 'draft', :rewardKind, :valueConfig, :unitType, :unitCode, :adminId)
         RETURNING id;`,
        {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: {
            rewardId,
            rewardKind: reward.rewardKind,
            valueConfig: reward.valueConfig === null ? null : JSON.stringify(reward.valueConfig),
            unitType: reward.unitType,
            unitCode: reward.unitCode,
            adminId,
          },
        },
      )) as unknown as [Array<{ id: number }>];
      const versionId = versionRows[0].id;

      await context.query(
        `INSERT INTO reward_config.reward_policies (reward_system_id, policy_code, name, status)
         VALUES (:rewardId, :policyCode, :policyName, 'active');`,
        {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: { rewardId, policyCode: reward.policyCode, policyName: reward.policyName },
        },
      );

      for (const countryCode of COUNTRY_CODES) {
        await context.query(
          `INSERT INTO reward_config.reward_country_assignments (reward_id, country_id, assigned_by)
           SELECT :rewardId, (SELECT id FROM reward_config.countries WHERE code = :countryCode), :adminId;`,
          {
            type: QueryTypes.RAW,
            transaction: t,
            replacements: { rewardId, countryCode, adminId },
          },
        );
        await context.query(
          `INSERT INTO reward_config.reward_version_country_assignments
             (reward_version_id, reward_id, country_id, status, assigned_by)
           SELECT :versionId, :rewardId, (SELECT id FROM reward_config.countries WHERE code = :countryCode),
                  'active', :adminId;`,
          {
            type: QueryTypes.RAW,
            transaction: t,
            replacements: { versionId, rewardId, countryCode, adminId },
          },
        );
      }
    }

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Reverses everything this migration added, by exact code/marker match — except the 2 junk
 * categories `up()` deleted, which cannot come back (their original content was never recorded
 * here — they were confirmed leftover e2e fixtures, not real data, before this migration was
 * written). The same accepted, documented exception `T900_001`'s own header records at larger
 * scale; this migration's own destructive step is exactly 2 rows, not a database-wide reset.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    const systemCodes = REWARDS.map((r) => r.systemCode);
    await context.query(
      `DELETE FROM reward_config.reward_version_country_assignments
        WHERE reward_id IN (SELECT id FROM reward_config.reward_systems WHERE system_code IN (:systemCodes));`,
      { type: QueryTypes.RAW, transaction: t, replacements: { systemCodes } },
    );
    await context.query(
      `DELETE FROM reward_config.reward_country_assignments
        WHERE reward_id IN (SELECT id FROM reward_config.reward_systems WHERE system_code IN (:systemCodes));`,
      { type: QueryTypes.RAW, transaction: t, replacements: { systemCodes } },
    );
    await context.query(
      `DELETE FROM reward_config.reward_policies
        WHERE reward_system_id IN (SELECT id FROM reward_config.reward_systems WHERE system_code IN (:systemCodes));`,
      { type: QueryTypes.RAW, transaction: t, replacements: { systemCodes } },
    );
    await context.query(
      `DELETE FROM reward_config.reward_versions
        WHERE reward_id IN (SELECT id FROM reward_config.reward_systems WHERE system_code IN (:systemCodes));`,
      { type: QueryTypes.RAW, transaction: t, replacements: { systemCodes } },
    );
    await context.query(
      `DELETE FROM reward_config.reward_systems WHERE system_code IN (:systemCodes);`,
      {
        type: QueryTypes.RAW,
        transaction: t,
        replacements: { systemCodes },
      },
    );

    const subCategoryCodes = NEW_CATEGORIES.map((c) => c.subCategoryCode);
    const categoryCodes = NEW_CATEGORIES.map((c) => c.categoryCode);
    await context.query(
      `DELETE FROM reward_config.reward_sub_categories
        WHERE sub_category_code IN (:subCategoryCodes)
          AND category_id IN (
            SELECT id FROM reward_config.reward_categories WHERE category_code IN (:categoryCodes)
          );`,
      { type: QueryTypes.RAW, transaction: t, replacements: { subCategoryCodes, categoryCodes } },
    );
    await context.query(
      `DELETE FROM reward_config.reward_categories WHERE category_code IN (:categoryCodes);`,
      {
        type: QueryTypes.RAW,
        transaction: t,
        replacements: { categoryCodes },
      },
    );

    await context.query(`DELETE FROM reward_config.admin_users WHERE email = :email;`, {
      type: QueryTypes.RAW,
      transaction: t,
      replacements: { email: BOOTSTRAP_ADMIN_EMAIL },
    });
    await context.query(
      `DELETE FROM reward_config.tenant_api_keys WHERE key_prefix = :keyPrefix;`,
      {
        type: QueryTypes.RAW,
        transaction: t,
        replacements: { keyPrefix: BOOTSTRAP_API_KEY_PREFIX },
      },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
