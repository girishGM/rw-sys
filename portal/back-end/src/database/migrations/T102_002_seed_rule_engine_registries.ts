import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-102 — day-1 seed data for the two registries created in `T102_001`: 5 resolvers covering
 * ~95% of anticipated future rules (`rules-reward/Reward-System.md`'s own estimate) and the 13
 * comparison operators every day-1 rule needs.
 *
 * Kept as its own migration, separate from the DDL, so a rollback of the seed data alone (this
 * file's `down()`) doesn't require touching the table-creation migration, and so a future
 * "add one more resolver" change is a new, later-numbered seed migration rather than an edit to
 * this one (same reasoning `T091_001`'s own header gives for not editing an already-applied
 * migration in place).
 *
 * `WHERE NOT EXISTS` guards on `resolver_code`/`operator_code` make this idempotent on a second
 * `db:migrate` run without relying on `ON CONFLICT` (there is a real unique constraint on both
 * codes from `T102_001`, so `ON CONFLICT` would also work here — `WHERE NOT EXISTS` is used for
 * consistency with `T105_002`, which cannot rely on `ON CONFLICT` at all, see that file's header).
 */
const RESOLVERS: ReadonlyArray<{
  code: string;
  name: string;
  description: string;
  handlerClass: string;
  inputSchema: Record<string, unknown>;
}> = [
  {
    code: 'JSONPATH_PAYLOAD',
    name: 'Incoming Event Payload',
    description: 'Reads a fact via JSONPath from the incoming transaction/activity event payload.',
    handlerClass: 'com.reward.resolvers.JsonPathPayloadResolver',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', description: 'JSONPath into the event payload' } },
    },
  },
  {
    code: 'TRACKER_STATE_LOOKUP',
    name: 'Sibling Tracker Component Lookup',
    description: 'Reads a property off a sibling tracker component within the same journey.',
    handlerClass: 'com.reward.resolvers.TrackerStateLookupResolver',
    inputSchema: {
      type: 'object',
      required: ['statusKey'],
      properties: {
        statusKey: { type: 'string', description: 'Which property on the sibling to read' },
      },
    },
  },
  {
    code: 'AGGREGATE_SQL',
    name: 'Pre-Registered Aggregate Query',
    description: 'Runs a pre-registered aggregate SQL template (count/sum) over a rolling window.',
    handlerClass: 'com.reward.resolvers.AggregateSqlResolver',
    inputSchema: {
      type: 'object',
      required: ['aggregateTemplate'],
      properties: {
        aggregateTemplate: { type: 'string', description: 'Named, pre-registered SQL template' },
      },
    },
  },
  {
    code: 'CUSTOMER_PROFILE_API',
    name: 'Cached Customer Profile',
    description: 'Reads a field from the cached customer profile service (segment, tier, KYC).',
    handlerClass: 'com.reward.resolvers.CustomerProfileApiResolver',
    inputSchema: {
      type: 'object',
      required: ['field'],
      properties: { field: { type: 'string', description: 'Field on the customer profile' } },
    },
  },
  {
    code: 'SCHEDULE_CONTEXT',
    name: 'Current Timestamp / Timezone',
    description: 'Reads the current event timestamp/timezone context (time window, day of week).',
    handlerClass: 'com.reward.resolvers.ScheduleContextResolver',
    inputSchema: {
      type: 'object',
      required: ['field'],
      properties: { field: { type: 'string', enum: ['currentTime', 'dayOfWeek'] } },
    },
  },
];

const OPERATORS: ReadonlyArray<{
  code: string;
  displayName: string;
  valueType: 'scalar' | 'array' | 'range' | 'number';
  handlerClass: string;
  dataTypes: readonly string[];
}> = [
  {
    code: 'equals',
    displayName: 'Equals',
    valueType: 'scalar',
    handlerClass: 'EqualsOperator',
    dataTypes: ['string', 'number', 'boolean', 'date'],
  },
  {
    code: 'not_equals',
    displayName: 'Not Equals',
    valueType: 'scalar',
    handlerClass: 'NotEqualsOperator',
    dataTypes: ['string', 'number', 'boolean', 'date'],
  },
  {
    code: 'in',
    displayName: 'In',
    valueType: 'array',
    handlerClass: 'InOperator',
    dataTypes: ['string', 'number'],
  },
  {
    code: 'not_in',
    displayName: 'Not In',
    valueType: 'array',
    handlerClass: 'NotInOperator',
    dataTypes: ['string', 'number'],
  },
  {
    code: 'contains',
    displayName: 'Contains',
    valueType: 'scalar',
    handlerClass: 'ContainsOperator',
    dataTypes: ['string'],
  },
  {
    code: 'greater_than',
    displayName: 'Greater Than',
    valueType: 'number',
    handlerClass: 'GreaterThanOperator',
    dataTypes: ['number'],
  },
  {
    code: 'less_than',
    displayName: 'Less Than',
    valueType: 'number',
    handlerClass: 'LessThanOperator',
    dataTypes: ['number'],
  },
  {
    code: 'between',
    displayName: 'Between',
    valueType: 'range',
    handlerClass: 'BetweenOperator',
    dataTypes: ['number', 'date', 'string'],
  },
  {
    code: 'at_least',
    displayName: 'At Least',
    valueType: 'number',
    handlerClass: 'AtLeastOperator',
    dataTypes: ['number'],
  },
  {
    code: 'regex',
    displayName: 'Matches Pattern',
    valueType: 'scalar',
    handlerClass: 'RegexOperator',
    dataTypes: ['string'],
  },
  {
    code: 'days_since_gte',
    displayName: 'Days Since ≥',
    valueType: 'number',
    handlerClass: 'DaysSinceGteOperator',
    dataTypes: ['date'],
  },
  {
    code: 'days_since_lte',
    displayName: 'Days Since ≤',
    valueType: 'number',
    handlerClass: 'DaysSinceLteOperator',
    dataTypes: ['date'],
  },
  {
    code: 'days_since_between',
    displayName: 'Days Since Between',
    valueType: 'range',
    handlerClass: 'DaysSinceBetweenOperator',
    dataTypes: ['date'],
  },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const r of RESOLVERS) {
      await context.query(
        `INSERT INTO reward_config.rule_resolvers
           (resolver_code, name, description, handler_class, input_schema, status)
         SELECT :code, :name, :description, :handlerClass, :inputSchema, 'active'
         WHERE NOT EXISTS (
           SELECT 1 FROM reward_config.rule_resolvers WHERE resolver_code = :code
         );`,
        {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: {
            code: r.code,
            name: r.name,
            description: r.description,
            handlerClass: r.handlerClass,
            inputSchema: JSON.stringify(r.inputSchema),
          },
        },
      );
    }

    for (const o of OPERATORS) {
      await context.query(
        `INSERT INTO reward_config.rule_operators
           (operator_code, display_name, expected_value_type, handler_class, applicable_data_types, status)
         SELECT :code, :displayName, :valueType, :handlerClass, :dataTypes, 'active'
         WHERE NOT EXISTS (
           SELECT 1 FROM reward_config.rule_operators WHERE operator_code = :code
         );`,
        {
          type: QueryTypes.RAW,
          transaction: t,
          replacements: {
            code: o.code,
            displayName: o.displayName,
            valueType: o.valueType,
            handlerClass: o.handlerClass,
            dataTypes: JSON.stringify(o.dataTypes),
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

export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    // Sequelize's named-replacement array expansion produces a bare comma list ("'a', 'b'"),
    // which is valid inside IN (...) but not inside ANY(...) — the latter needs an ARRAY[...]
    // or a real array parameter. IN (:codes) is the form Sequelize's replacement is meant for.
    const codes = RESOLVERS.map((r) => r.code);
    await context.query(
      `DELETE FROM reward_config.rule_resolvers WHERE resolver_code IN (:codes);`,
      {
        type: QueryTypes.RAW,
        transaction: t,
        replacements: { codes },
      },
    );
    const opCodes = OPERATORS.map((o) => o.code);
    await context.query(
      `DELETE FROM reward_config.rule_operators WHERE operator_code IN (:codes);`,
      {
        type: QueryTypes.RAW,
        transaction: t,
        replacements: { codes: opCodes },
      },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
