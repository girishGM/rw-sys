/**
 * T-003 — SQL log redaction, extracted from `sequelize.provider.ts` (T-002) into its own
 * file so it can be unit-tested in isolation and reused by anything else that needs to log
 * SQL (01-DATABASE.md §6, implementation note 6). Sequelize's default logger prints bind
 * parameter values verbatim, which would put Argon2id hashes, refresh-token hashes and
 * other secrets straight into stdout/log aggregation — every SQL logger in this codebase
 * must go through this function, never `console.log`/`console.debug` directly on raw SQL.
 */

/** Strips positional bind-parameter placeholders' values and inlined VALUES tuples out of
 * a logged SQL line, keeping the statement shape (table/column names, clause structure)
 * fully visible for debugging while the actual data never appears. */
export function redactSql(sql: string): string {
  return sql.replace(/\$\d+/g, '$?').replace(/(?<=VALUES\s*)\([^)]*\)/gi, '(…)');
}
