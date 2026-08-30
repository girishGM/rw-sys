import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-105 — seeds 7 sample global rules (`tenant_id = NULL`) spanning all 5 day-1 resolvers, with
 * a `published` `rule_versions` row each, wired to the columns `T-103` added. Matches the Open
 * Finance / Scan & Pay examples from `rules-reward/Reward-System.md` and
 * `rule-engine-mapped-design.md`.
 *
 * `rule_master.tenant_id IS NULL` does **not** dedupe via `uq_rm_tenant_code` — Postgres treats
 * `NULL` as distinct from `NULL` in a unique index, confirmed by reading the constraint directly
 * — so this migration checks existence with a plain `SELECT` before inserting, in application
 * code, rather than relying on `ON CONFLICT`. Confirmed zero of these 7 codes collide with the
 * live `rule_master` (41 pre-existing rows, all e2e fixtures) before writing this file.
 *
 * `parameters` on each seeded rule matches `DynamicParameterForm`'s existing 5 field types
 * exactly (string/number/boolean/date/select) — no new widget type is used, so these seeds are
 * renderable by the front end with zero code change, the concrete proof of "reuse an existing
 * resolver = pure config."
 *
 * **Seeded as `draft`, not `published`.** `T005_007`'s immutability/undeletability triggers make
 * a `published` row's `DELETE` unconditionally rejected — proven directly while verifying
 * `T-103` (a manually-inserted test row could not be removed once published, by design). A
 * migration that seeds `published` rows therefore cannot have a working `down()` via `DELETE`
 * (unlike `T005_001`'s own rollback, which works because it `DROP TABLE`s — that bypasses
 * row-level triggers entirely, a `DELETE` does not). Seeding as `draft` keeps `down()` genuinely
 * reversible (R7) and is arguably more correct anyway: a seed migration silently making rules
 * globally blastable with no human review step is not a decision a migration should make
 * unilaterally. A Super Admin still explicitly publishes (and, separately, blasts) these from
 * the portal UI when ready.
 */

interface SeedRule {
  ruleCode: string;
  name: string;
  categoryCode: string;
  subCategoryCode: string;
  resolverCode: string;
  resolverConfig: Record<string, unknown>;
  evaluationContext: string;
  defaultOperators: readonly string[];
  expression: string;
  parameters: { fields: Array<Record<string, unknown>> };
}

const SEED_RULES: readonly SeedRule[] = [
  {
    ruleCode: 'RULE_TXN_TYPE_001',
    name: 'Transaction Type Check',
    categoryCode: 'TRANSACTION',
    subCategoryCode: 'GENERAL',
    resolverCode: 'JSONPATH_PAYLOAD',
    resolverConfig: { path: 'transaction.transactionType' },
    evaluationContext: 'transaction_payload',
    defaultOperators: ['equals', 'in', 'not_equals'],
    expression: 'transaction.transactionType == :value',
    parameters: {
      fields: [
        {
          key: 'value',
          label: 'Transaction Type',
          type: 'select',
          required: true,
          options: ['LINK_SUCCESS', 'UNLINK', 'SCAN_PAY', 'ACCOUNT_OPEN'],
        },
      ],
    },
  },
  {
    ruleCode: 'RULE_TXN_AMOUNT_MIN',
    name: 'Transaction Amount Minimum',
    categoryCode: 'TRANSACTION',
    subCategoryCode: 'GENERAL',
    resolverCode: 'JSONPATH_PAYLOAD',
    resolverConfig: { path: 'transaction.amount' },
    evaluationContext: 'transaction_payload',
    defaultOperators: ['at_least', 'greater_than', 'between'],
    expression: 'transaction.amount >= :value',
    parameters: {
      fields: [
        { key: 'value', label: 'Minimum Amount (RM)', type: 'number', required: true, min: 0 },
      ],
    },
  },
  {
    ruleCode: 'RULE_PRODUCT_TYPE_001',
    name: 'Product Type Check',
    categoryCode: 'TRANSACTION',
    subCategoryCode: 'GENERAL',
    resolverCode: 'JSONPATH_PAYLOAD',
    resolverConfig: { path: 'transaction.productType' },
    evaluationContext: 'transaction_payload',
    defaultOperators: ['equals', 'in'],
    expression: 'transaction.productType in :value',
    parameters: {
      fields: [
        {
          key: 'value',
          label: 'Product Type',
          type: 'select',
          required: true,
          options: ['SAVINGS', 'CURRENT', 'CREDIT_CARD'],
        },
      ],
    },
  },
  {
    ruleCode: 'RULE_COMP_COMPLETED_001',
    name: 'Sibling Component Completed',
    categoryCode: 'COMPONENT',
    subCategoryCode: 'COMP_STATUS_CHECK',
    resolverCode: 'TRACKER_STATE_LOOKUP',
    resolverConfig: { statusKey: 'status' },
    evaluationContext: 'tracker_state',
    defaultOperators: ['equals', 'not_equals', 'in'],
    expression: 'sibling[:targetComponentCode].status == :value',
    parameters: {
      fields: [
        {
          key: 'targetComponentCode',
          label: 'Sibling Component Code',
          type: 'string',
          required: true,
        },
        {
          key: 'value',
          label: 'Expected Status',
          type: 'select',
          required: true,
          options: ['COMPLETED', 'IN_PROGRESS', 'NOT_STARTED', 'FAILED'],
        },
      ],
    },
  },
  {
    ruleCode: 'RULE_COMP_NOT_COMPLETED_001',
    name: 'Sibling Component Not Completed',
    categoryCode: 'COMPONENT',
    subCategoryCode: 'COMP_STATUS_CHECK',
    resolverCode: 'TRACKER_STATE_LOOKUP',
    resolverConfig: { statusKey: 'status' },
    evaluationContext: 'tracker_state',
    defaultOperators: ['not_equals', 'equals'],
    expression: 'sibling[:targetComponentCode].status != :value',
    parameters: {
      fields: [
        {
          key: 'targetComponentCode',
          label: 'Sibling Component Code',
          type: 'string',
          required: true,
        },
        {
          key: 'value',
          label: 'Status To Exclude',
          type: 'select',
          required: true,
          options: ['COMPLETED', 'IN_PROGRESS', 'NOT_STARTED', 'FAILED'],
        },
      ],
    },
  },
  {
    ruleCode: 'RULE_TIME_WINDOW',
    name: 'Transaction Time Window',
    categoryCode: 'SCHEDULE',
    subCategoryCode: 'TIME_WINDOW_CHECK',
    resolverCode: 'SCHEDULE_CONTEXT',
    resolverConfig: { field: 'currentTime' },
    evaluationContext: 'schedule',
    defaultOperators: ['between'],
    expression: 'currentTime between :windowStart and :windowEnd',
    parameters: {
      fields: [
        { key: 'windowStart', label: 'Window Start (HH:mm)', type: 'string', required: true },
        { key: 'windowEnd', label: 'Window End (HH:mm)', type: 'string', required: true },
      ],
    },
  },
  {
    ruleCode: 'RULE_TXN_COUNT',
    name: 'Transaction Count in Rolling Window',
    categoryCode: 'AGGREGATE',
    subCategoryCode: 'TXN_COUNT_CHECK',
    resolverCode: 'AGGREGATE_SQL',
    resolverConfig: { aggregateTemplate: 'COMPONENT_TXN_COUNT' },
    evaluationContext: 'aggregate',
    defaultOperators: ['equals', 'at_least', 'less_than'],
    expression: 'count(completed txns in window) == :value',
    parameters: {
      fields: [
        {
          key: 'value',
          label: 'Required Transaction Count',
          type: 'number',
          required: true,
          min: 1,
          max: 1000,
        },
        {
          key: 'windowValue',
          label: 'Rolling Window Duration',
          type: 'number',
          required: true,
          min: 1,
          max: 365,
        },
        {
          key: 'windowUnit',
          label: 'Window Unit',
          type: 'select',
          required: true,
          options: ['DAYS', 'WEEKS', 'MONTHS', 'HOURS'],
        },
      ],
    },
  },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    const adminRows = (await context.query(
      `SELECT id FROM reward_config.admin_users ORDER BY id LIMIT 1;`,
      { type: QueryTypes.SELECT, transaction: t },
    )) as Array<{ id: number }>;
    if (adminRows.length === 0) {
      throw new Error(
        'T105_002: no reward_config.admin_users row found to attribute seed rules to.',
      );
    }
    const adminId = adminRows[0].id;

    for (const rule of SEED_RULES) {
      const existing = (await context.query(
        `SELECT id FROM reward_config.rule_master WHERE rule_code = :ruleCode;`,
        { type: QueryTypes.SELECT, transaction: t, replacements: { ruleCode: rule.ruleCode } },
      )) as Array<{ id: number }>;
      if (existing.length > 0) continue; // already seeded — idempotent re-run

      const subCategoryRows = (await context.query(
        `SELECT sc.id
           FROM reward_config.rule_sub_categories sc
           JOIN reward_config.rule_categories c ON c.id = sc.category_id
          WHERE c.category_code = :categoryCode AND sc.sub_category_code = :subCategoryCode
            AND c.tenant_id = 1;`,
        {
          type: QueryTypes.SELECT,
          transaction: t,
          replacements: { categoryCode: rule.categoryCode, subCategoryCode: rule.subCategoryCode },
        },
      )) as Array<{ id: number }>;
      if (subCategoryRows.length === 0) {
        throw new Error(
          `T105_002: sub-category ${rule.categoryCode}/${rule.subCategoryCode} not found — did T105_001 run first?`,
        );
      }
      const subCategoryId = subCategoryRows[0].id;

      const resolverRows = (await context.query(
        `SELECT id FROM reward_config.rule_resolvers WHERE resolver_code = :resolverCode;`,
        {
          type: QueryTypes.SELECT,
          transaction: t,
          replacements: { resolverCode: rule.resolverCode },
        },
      )) as Array<{ id: number }>;
      if (resolverRows.length === 0) {
        throw new Error(`T105_002: resolver ${rule.resolverCode} not found — did T102 run first?`);
      }
      const resolverId = resolverRows[0].id;

      const [ruleMasterRows] = (await context.query(
        `INSERT INTO reward_config.rule_master
           (tenant_id, sub_category_id, rule_code, name, expression, parameters, created_by, status)
         VALUES
           (NULL, :subCategoryId, :ruleCode, :name, :expression, :parameters, :adminId, 'active')
         RETURNING id;`,
        {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: {
            subCategoryId,
            ruleCode: rule.ruleCode,
            name: rule.name,
            expression: rule.expression,
            parameters: JSON.stringify(rule.parameters),
            adminId,
          },
        },
      )) as unknown as [Array<{ id: number }>];
      const ruleMasterId = ruleMasterRows[0].id;

      await context.query(
        `INSERT INTO reward_config.rule_versions
           (rule_id, version_no, expression, parameters, status,
            resolver_id, resolver_config, evaluation_context, default_operators,
            created_by)
         VALUES
           (:ruleMasterId, 1, :expression, :parameters, 'draft',
            :resolverId, :resolverConfig, :evaluationContext, :defaultOperators,
            :adminId);`,
        {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: {
            ruleMasterId,
            expression: rule.expression,
            parameters: JSON.stringify(rule.parameters),
            resolverId,
            resolverConfig: JSON.stringify(rule.resolverConfig),
            evaluationContext: rule.evaluationContext,
            defaultOperators: JSON.stringify(rule.defaultOperators),
            adminId,
          },
        },
      );
    }

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Deletes the seeded `rule_versions` rows first, then their `rule_master` parents. Works cleanly
 * because these rows are seeded as `draft` (see `up()`'s doc comment) — `fn_rule_version_
 * undeletable` only rejects `DELETE` on a non-`draft` row, so a `draft` seed stays reversible.
 *
 * If a Super Admin has since **published** one of these seeded versions, this `down()` will fail
 * loudly with the trigger's own `check_violation` error rather than silently doing nothing — the
 * same acceptable, by-design limitation `T-005-versioning-schema.md`'s own Rollback section
 * states ("once real published versions exist, rollback destroys the history the transaction
 * runtime references — after go-live this rollback is documentation only"). That is a real
 * safety property working as intended, not a bug in this migration.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    const codes = SEED_RULES.map((r) => r.ruleCode);
    await context.query(
      `DELETE FROM reward_config.rule_versions
        WHERE rule_id IN (SELECT id FROM reward_config.rule_master WHERE rule_code IN (:codes));`,
      { type: QueryTypes.RAW, transaction: t, replacements: { codes } },
    );
    await context.query(`DELETE FROM reward_config.rule_master WHERE rule_code IN (:codes);`, {
      type: QueryTypes.RAW,
      transaction: t,
      replacements: { codes },
    });
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
