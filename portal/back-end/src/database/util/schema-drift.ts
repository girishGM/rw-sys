import type { Sequelize, Model } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/** Any concrete `sequelize-typescript` model class (its static/constructor side, not an
 * instance) — deliberately `typeof Model` rather than sequelize's own narrower
 * `ModelStatic<T>`, which doesn't expose `options`/`tableName`/`rawAttributes` in this
 * version's type definitions even though they exist at runtime. */
export type AnyModelClass = typeof Model;

/**
 * T-003 implementation note 8 — `reward_config` is live and can change under us; this turns
 * silent schema drift into a fast, specific CI failure rather than a runtime 500 discovered
 * by a user. Deliberately queries `information_schema.columns` directly (the exact
 * mechanism the task file names) rather than going through Sequelize's own
 * `describeTable`, so the comparison is transparent and easy to reason about from this one
 * file.
 */

interface InformationSchemaColumn {
  column_name: string;
  data_type: string;
}

/** Postgres `information_schema.columns.data_type` values a given Sequelize `DataType.key`
 * is considered compatible with. Intentionally coarse (e.g. any `character varying` length
 * is fine for any `STRING`) — this check exists to catch a *missing or renamed* column or a
 * completely different underlying type (e.g. int → text), not to duplicate a full DDL diff. */
const COMPATIBLE_PG_TYPES: Record<string, string[]> = {
  INTEGER: ['integer'],
  BIGINT: ['bigint'],
  STRING: ['character varying'],
  CHAR: ['character'],
  TEXT: ['text'],
  BOOLEAN: ['boolean'],
  DATE: ['timestamp with time zone', 'timestamp without time zone'],
  DATEONLY: ['date'],
  TIME: ['time without time zone', 'time with time zone'],
  DECIMAL: ['numeric'],
  JSONB: ['jsonb'],
  JSON: ['json'],
  UUID: ['uuid'],
  INET: ['inet'],
};

export interface DriftIssue {
  model: string;
  schema: string;
  table: string;
  column: string;
  detail: string;
}

/**
 * Checks a single model's `rawAttributes` against the live `information_schema.columns` for
 * its declared `schema`/`tableName`. Returns one {@link DriftIssue} per problem found —
 * empty array means no drift.
 */
export async function checkModelDrift(
  sequelize: Sequelize,
  model: AnyModelClass,
): Promise<DriftIssue[]> {
  const schema = (model.options.schema as string) ?? 'public';
  const tableName = model.tableName as string;

  const rows = await sequelize.query<InformationSchemaColumn>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = :schema AND table_name = :tableName`,
    { replacements: { schema, tableName }, type: QueryTypes.SELECT },
  );
  const columnsByName = new Map(rows.map((r) => [r.column_name, r.data_type]));

  const issues: DriftIssue[] = [];
  for (const [attributeName, attribute] of Object.entries(model.rawAttributes)) {
    const columnName = attribute.field ?? attributeName;
    const liveType = columnsByName.get(columnName);

    if (liveType === undefined) {
      issues.push({
        model: model.name,
        schema,
        table: tableName,
        column: columnName,
        detail: `column "${columnName}" does not exist on ${schema}.${tableName}`,
      });
      continue;
    }

    const typeKey = (attribute.type as { key?: string })?.key;
    const allowed = typeKey ? COMPATIBLE_PG_TYPES[typeKey] : undefined;
    if (allowed && !allowed.includes(liveType)) {
      issues.push({
        model: model.name,
        schema,
        table: tableName,
        column: columnName,
        detail: `expected a type compatible with ${typeKey} (${allowed.join('/')}), found "${liveType}"`,
      });
    }
  }

  return issues;
}

/** Runs {@link checkModelDrift} for every model in `models` and flattens the results. */
export async function checkSchemaDrift(
  sequelize: Sequelize,
  models: AnyModelClass[],
): Promise<DriftIssue[]> {
  const results = await Promise.all(models.map((model) => checkModelDrift(sequelize, model)));
  return results.flat();
}
