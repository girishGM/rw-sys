import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Ad hoc demo-data seed, phase 2b (see `task/reset-reference-data-keep-users`, alongside
 * `T900_003`'s reward definitions). Defines the 3 rules the user described for a scan & pay
 * activity tracker: an activity-value check, an activity time-window check, and a sibling-
 * component completion-count check — each with the specific fields left to the Maker to fill in
 * at bind time, exactly as described in that conversation.
 *
 * Every field/resolver/operator/provider code below was verified against the **live** database
 * and the shared Zod contract (`ruleParameterFieldSchema`/`buildRuleValueSchema` in
 * `packages/shared/src/rule.schema.ts`/`campaign.schema.ts`) before writing this file — the
 * reward-definitions migration in this same session hit two real constraint surprises by not
 * doing that first.
 *
 * ### Rule 1 — Activity Value Check (`RULE_ACTIVITY_VALUE_001`)
 *
 * `TRANSACTION` category has only a `GENERAL` sub-category live — none fits "compare the
 * activity's value against a Maker-chosen threshold" precisely, so this adds `VALUE_CHECK`.
 * `value` and `currency` are both Maker-supplied `parameters` fields; the comparison *operator*
 * (equals/greater than/less than/between/at least) is **not** a parameter — it is the existing,
 * separate per-binding `operator` mechanism (`defaultOperators` here, chosen by the Maker via
 * `UpdateComponentRuleValuesDto.operator`, T-147), the same mechanism `RULE_TXN_AMOUNT_MIN`
 * (`T105_002`) already uses for its own single-operator case. `currency`'s options are a plain
 * hand-typed list (`T900_002`'s 3 demo countries' currencies) — there is no live context/API
 * provider for currency today (`field_context_providers`/`field_api_lookup_providers` carry
 * nothing currency-related; `tenant_currencies`, T-126, is never wired to either registry),
 * confirmed by reading both tables live before writing this field.
 *
 * ### Rule 2 — Activity Performed Window (`RULE_ACTIVITY_WINDOW_001`)
 *
 * Reuses the live `SCHEDULE`/`TIME_WINDOW_CHECK` category pair. One rule covers all three window
 * shapes the user described (daily hours / specific weekdays / specific days of a month) via a
 * `windowType` selector plus type-specific optional fields, rather than three separate rules —
 * the user described this as one configurable rule, not three. `resolverConfig.field` is fixed to
 * `currentTime` (not `dayOfWeek`) for all three shapes: `SCHEDULE_CONTEXT`'s live `input_schema`
 * only enumerates `currentTime`/`dayOfWeek`, and a raw instant lets whichever engine evaluates
 * this derive hour-of-day, day-of-week or day-of-month uniformly, without inventing an
 * undocumented third `field` value.
 *
 * **A real, disclosed limitation:** `ruleParameterFieldSchema` has exactly 5 field types
 * (`string`/`number`/`boolean`/`date`/`select`, confirmed live in `rule.schema.ts`) and no
 * multi-select type, and — also confirmed by reading `buildRuleValueSchema` directly — a `select`
 * field's value is always a single string, regardless of which operator a binding picks; operator
 * choice does not change a field's shape. So "specific **days** in a week" (plural) cannot be a
 * true multi-select; `daysOfWeek`/`daysOfMonth` are `string` fields holding a documented
 * comma-separated list (e.g. `MON,WED,FRI` / `1,15,28`) instead. Not a schema bug — a real gap in
 * the 5-type system, flagged here rather than silently worked around with an unsupported shape.
 *
 * ### Rule 3 — Sibling Component Completion Count (`RULE_SIBLING_COMPONENT_COUNT_001`)
 *
 * Reuses the live `AGGREGATE`/`TXN_COUNT_CHECK` category pair (T105_002's own `RULE_TXN_COUNT`
 * used the same pair for the same "count within a period" shape). The sibling-component picker
 * uses the **correct**, current mechanism — `type: 'select'` with
 * `valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' }` — confirmed
 * live-registered and `active`. This deliberately does **not** copy `T105_002`'s own
 * `RULE_COMP_COMPLETED_001`, whose `targetComponentCode` field is a plain `type: 'string'` with
 * no `valueSource` at all — it predates T-121/T-122 and was never updated, so it does not
 * actually render a dropdown; copying it here would reproduce a defect state as if it were the
 * pattern to follow. `resetPeriodUnit` extends `RULE_TXN_COUNT`'s own `DAYS/WEEKS/MONTHS/HOURS`
 * options with the two the user asked for beyond that: `CAMPAIGN_PERIOD` and
 * `BEYOND_CAMPAIGN_PERIOD`. Like every `windowUnit`/`aggregateTemplate` value here, this is pure
 * parameter-shape/authoring metadata with no matching runtime logic in this codebase — confirmed
 * by grep before writing: `AGGREGATE_SQL`/`aggregateTemplate`/`windowUnit` are read nowhere in
 * `portal/back-end/src` outside migration files themselves, exactly as `T102_001`'s own header
 * states ("a different microservice, out of scope for this repo, does that").
 *
 * ### The bootstrap `admin_users` row
 *
 * `rule_master.created_by` **does** carry a real FK to `admin_users` (unlike
 * `reward_versions.created_by`, which T900_003's header notes does not) — reuses whatever row
 * already exists (from `T900_003`'s own bootstrap, if that ran first, or created fresh here with
 * the identical marker/guard if it did not) rather than assuming one migration always precedes
 * the other. `down()` deletes rule data only, never the shared bootstrap admin row itself — see
 * that function's own comment for why.
 */

const BOOTSTRAP_ADMIN_EMAIL = 'bootstrap-admin@t900.invalid';
const BOOTSTRAP_API_KEY_PREFIX = 'T900BOOT';

interface SubCategorySeed {
  categoryCode: string;
  subCategoryCode: string;
  subCategoryName: string;
}

/** Only `TRANSACTION/VALUE_CHECK` is new — `SCHEDULE/TIME_WINDOW_CHECK` and
 * `AGGREGATE/TXN_COUNT_CHECK` already exist live and are reused as-is. */
const NEW_SUB_CATEGORIES: readonly SubCategorySeed[] = [
  { categoryCode: 'TRANSACTION', subCategoryCode: 'VALUE_CHECK', subCategoryName: 'Value Check' },
];

interface RuleField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'select';
  required: boolean;
  options?: readonly string[];
  valueSource?: { kind: 'CONTEXT_LOOKUP'; contextProvider: string };
  min?: number;
  helpText?: string;
}

interface RuleSeed {
  ruleCode: string;
  name: string;
  categoryCode: string;
  subCategoryCode: string;
  resolverCode: string;
  resolverConfig: Record<string, unknown>;
  evaluationContext: string;
  defaultOperators: readonly string[];
  expression: string;
  fields: readonly RuleField[];
}

const RULES: readonly RuleSeed[] = [
  {
    ruleCode: 'RULE_ACTIVITY_VALUE_001',
    name: 'Activity Value Check',
    categoryCode: 'TRANSACTION',
    subCategoryCode: 'VALUE_CHECK',
    resolverCode: 'JSONPATH_PAYLOAD',
    resolverConfig: { path: 'transaction.amount' },
    evaluationContext: 'transaction_payload',
    defaultOperators: ['equals', 'greater_than', 'less_than', 'between', 'at_least'],
    expression: 'transaction.amount :operator :value (transaction.currency == :currency)',
    fields: [
      { key: 'value', label: 'Value', type: 'number', required: true, min: 0 },
      {
        key: 'currency',
        label: 'Currency',
        type: 'select',
        required: true,
        options: ['MYR', 'SGD', 'KHR'],
      },
    ],
  },
  {
    ruleCode: 'RULE_ACTIVITY_WINDOW_001',
    name: 'Activity Performed Window',
    categoryCode: 'SCHEDULE',
    subCategoryCode: 'TIME_WINDOW_CHECK',
    resolverCode: 'SCHEDULE_CONTEXT',
    resolverConfig: { field: 'currentTime' },
    evaluationContext: 'schedule',
    defaultOperators: ['between', 'in', 'equals'],
    expression: 'currentTime within the :windowType window',
    fields: [
      {
        key: 'windowType',
        label: 'Window Type',
        type: 'select',
        required: true,
        options: ['DAILY_HOURS', 'WEEKLY_DAYS', 'MONTHLY_DAYS'],
        helpText: 'Which of the three window shapes below applies to this binding.',
      },
      {
        key: 'windowStart',
        label: 'Window Start (HH:mm)',
        type: 'string',
        required: false,
        helpText: 'DAILY_HOURS only.',
      },
      {
        key: 'windowEnd',
        label: 'Window End (HH:mm)',
        type: 'string',
        required: false,
        helpText: 'DAILY_HOURS only.',
      },
      {
        key: 'daysOfWeek',
        label: 'Days of Week',
        type: 'string',
        required: false,
        helpText: 'WEEKLY_DAYS only. Comma-separated, e.g. MON,WED,FRI.',
      },
      {
        key: 'daysOfMonth',
        label: 'Days of Month',
        type: 'string',
        required: false,
        helpText: 'MONTHLY_DAYS only. Comma-separated day numbers, e.g. 1,15,28.',
      },
    ],
  },
  {
    ruleCode: 'RULE_SIBLING_COMPONENT_COUNT_001',
    name: 'Sibling Component Completion Count',
    categoryCode: 'AGGREGATE',
    subCategoryCode: 'TXN_COUNT_CHECK',
    resolverCode: 'AGGREGATE_SQL',
    resolverConfig: { aggregateTemplate: 'SIBLING_COMPONENT_COMPLETION_COUNT' },
    evaluationContext: 'aggregate',
    defaultOperators: ['equals', 'at_least', 'less_than'],
    expression: 'count(sibling component completions in window) :operator :requiredCount',
    fields: [
      {
        key: 'targetComponentId',
        label: 'Sibling Component',
        type: 'select',
        required: true,
        valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' },
      },
      { key: 'requiredCount', label: 'Required Count', type: 'number', required: true, min: 1 },
      {
        key: 'resetPeriodValue',
        label: 'Reset Period Duration',
        type: 'number',
        required: true,
        min: 1,
        helpText: 'Ignored when Reset Period Unit is CAMPAIGN_PERIOD.',
      },
      {
        key: 'resetPeriodUnit',
        label: 'Reset Period Unit',
        type: 'select',
        required: true,
        options: ['HOURS', 'DAYS', 'WEEKS', 'MONTHS', 'CAMPAIGN_PERIOD', 'BEYOND_CAMPAIGN_PERIOD'],
      },
    ],
  },
];

function parametersOf(rule: RuleSeed): { fields: readonly RuleField[] } {
  return { fields: rule.fields };
}

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const sc of NEW_SUB_CATEGORIES) {
      await context.query(
        `INSERT INTO reward_config.rule_sub_categories (category_id, sub_category_code, name)
         SELECT c.id, :subCategoryCode, :subCategoryName
         FROM reward_config.rule_categories c
         WHERE c.category_code = :categoryCode
           AND NOT EXISTS (
             SELECT 1 FROM reward_config.rule_sub_categories
             WHERE category_id = c.id AND sub_category_code = :subCategoryCode
           );`,
        { type: QueryTypes.RAW, transaction: t, replacements: { ...sc } },
      );
    }

    // Bootstrap admin_users — identical guard/marker to T900_003, reused if that already ran.
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
        'T900_004: no reward_config.admin_users row found to attribute rule seeds to.',
      );
    }
    const adminId = adminRows[0].id;

    for (const rule of RULES) {
      const existing = (await context.query(
        `SELECT id FROM reward_config.rule_master WHERE rule_code = :ruleCode;`,
        { type: QueryTypes.SELECT, transaction: t, replacements: { ruleCode: rule.ruleCode } },
      )) as Array<{ id: number }>;
      if (existing.length > 0) continue; // already seeded — idempotent re-run

      const subCategoryRows = (await context.query(
        `SELECT sc.id
           FROM reward_config.rule_sub_categories sc
           JOIN reward_config.rule_categories c ON c.id = sc.category_id
          WHERE c.category_code = :categoryCode AND sc.sub_category_code = :subCategoryCode;`,
        {
          type: QueryTypes.SELECT,
          transaction: t,
          replacements: { categoryCode: rule.categoryCode, subCategoryCode: rule.subCategoryCode },
        },
      )) as Array<{ id: number }>;
      if (subCategoryRows.length === 0) {
        throw new Error(
          `T900_004: sub-category ${rule.categoryCode}/${rule.subCategoryCode} not found.`,
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
        throw new Error(`T900_004: resolver ${rule.resolverCode} not found.`);
      }
      const resolverId = resolverRows[0].id;

      const parameters = parametersOf(rule);

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
            parameters: JSON.stringify(parameters),
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
            parameters: JSON.stringify(parameters),
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
 * Deletes the seeded `rule_versions` rows first (as `draft`, so `fn_rule_version_undeletable`
 * passes cleanly — see `T105_002`'s own `down()` for the identical reasoning), then their
 * `rule_master` parents, then the one new sub-category.
 *
 * Deliberately does **not** delete the bootstrap `admin_users`/`tenant_api_keys` rows: they are
 * shared with `T900_003`, and this migration cannot tell whether it created them or reused
 * `T900_003`'s. Leaving them is harmless — nothing in either migration enforces an FK to them
 * once their own rows are gone — and `T900_003`'s own `down()` already owns cleaning them up by
 * the identical marker.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    const codes = RULES.map((r) => r.ruleCode);
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

    for (const sc of NEW_SUB_CATEGORIES) {
      await context.query(
        `DELETE FROM reward_config.rule_sub_categories
          WHERE sub_category_code = :subCategoryCode
            AND category_id IN (
              SELECT id FROM reward_config.rule_categories WHERE category_code = :categoryCode
            );`,
        { type: QueryTypes.RAW, transaction: t, replacements: { ...sc } },
      );
    }

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
