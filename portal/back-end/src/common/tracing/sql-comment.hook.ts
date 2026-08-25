/**
 * T-019 — SQL comment injection, implementation note 4.
 *
 * > *"Prepend `/* cid=<correlationId> *​/` to every statement via a Sequelize hook. **This is the
 * > piece most systems skip and later wish they had**: it makes a slow query in the Postgres log
 * > traceable back to the user action that caused it. The comment must be built from the
 * > **validated** id (never raw input) and `*​/` must be impossible in it — the charset check
 * > guarantees that."*
 *
 * 08-OBSERVABILITY.md §2 says the same thing from the operator's side: *"Postgres retains it in
 * `pg_stat_activity` and `log_min_duration_statement` output … Without it, a slow query is an
 * orphan."*
 *
 * ---
 *
 * ## Why this wraps `sequelize.query` instead of using the `beforeQuery` hook
 *
 * The task file says "via a Sequelize hook", and that is the first thing anyone tries. It does
 * not work, and the reason is worth writing down so nobody spends an afternoon rediscovering it:
 * in `sequelize/lib/sequelize.js`, the statement text is a **local variable** by the time hooks
 * run —
 *
 * ```js
 * const query = new this.dialect.Query(connection, this, options);
 * await this.runHooks('beforeQuery', options, query);   // ← cannot reach `sql`
 * return await query.run(sql, bindParameters);          // ← `sql` from the enclosing scope
 * ```
 *
 * — so a `beforeQuery` hook can observe the query object but cannot change what is sent to
 * Postgres. Wrapping `Sequelize.prototype.query` on the one runtime instance is the only
 * interception point that sees the text before it is executed, and it is the same technique every
 * APM agent uses. It is confined to one function, it is reversible ({@link installSqlCommentHook}
 * returns its own uninstall), and it delegates with the original arguments untouched.
 *
 * Every model read and write reaches Postgres through `sequelize.query` (`QueryInterface.select`,
 * `.insert`, `.bulkUpdate` … all call it), so one wrapper covers `ScopedRepository`, the raw-SQL
 * repositories, and anything Wave 3 adds.
 *
 * ## Why the comment is only added inside a request
 *
 * Two independent reasons, and either alone would be sufficient:
 *
 *  1. **There is nothing to say otherwise.** A boot-time `authenticate()` or a scheduled job has
 *     no correlation id, and `/* cid=null *​/` is noise in every Postgres log line forever.
 *  2. **It keeps the blast radius at zero for introspection.** Sequelize identifies a handful of
 *     query kinds by `sql.startsWith(...)` — `SELECT table_name FROM information_schema.tables`,
 *     `insert into`, `show`, `describe`, `call` — and a leading comment would defeat those tests.
 *     Every one of them is issued by `sync()`, `showAllTables()` or `describeTable()`, i.e. by
 *     migration and introspection code that never runs inside an HTTP request. Gating on an
 *     active trace means this wrapper cannot reach them. (The migration CLI is a separate
 *     `Sequelize` instance on a separate role and is never wrapped at all — see
 *     `migration-connection.ts`.)
 *
 * ## Why the id is re-validated here
 *
 * `CorrelationMiddleware` already guarantees the charset, so this check can never fail today.
 * It is here because this is the one place a correlation id is interpolated into a string that is
 * **executed**, and the cost of being wrong is not a bad log line but a SQL comment an attacker
 * can close with `*​/`. A guard whose precondition is established two files away is a guard that
 * survives exactly as long as nobody refactors the other file. Failing the check drops the
 * comment; it never sanitises and keeps the value.
 */
import type { Sequelize } from 'sequelize-typescript';
import { CORRELATION_ID_PATTERN } from '@/common/errors/trace-id';
import { recordSpan, DB_SPAN_PREFIX } from './span.service';
import { TraceContext } from './trace-context';

/** What a statement's leading keyword is recorded as when it is not one of the four we name. */
export const UNKNOWN_SQL_VERB = 'query';

/**
 * The first identifier after `FROM`, `INTO`, `UPDATE` or `JOIN`, schema-qualified and possibly
 * quoted. Deliberately conservative: anything it does not match yields no `table` attribute at
 * all rather than a guess, and it can never capture a literal — the character class admits only
 * identifier characters, `.` and `"`.
 */
const TABLE_PATTERN =
  /\b(?:from|into|update|join)\s+("?[A-Za-z_][\w$]*"?(?:\."?[A-Za-z_][\w$]*"?)*)/i;

/** The leading SQL keyword, lower-cased. */
const VERB_PATTERN = /^\s*([A-Za-z]+)/;

/** Statement kinds that get their own span name. Anything else is `db.query`. */
const KNOWN_VERBS: ReadonlySet<string> = new Set(['select', 'insert', 'update', 'delete']);

/** The shape of `sequelize.query`, erased of its overloads so it can be wrapped once. */
type QueryFunction = (sql: unknown, options?: unknown) => Promise<unknown>;

/** A `{ query, values }` statement object, the other form `sequelize.query` accepts. */
interface StatementObject {
  query: string;
  [key: string]: unknown;
}

/**
 * Wraps `sequelize.query` so that every statement issued inside a request carries
 * `/* cid=<correlationId> *​/` and contributes to the request's `db` counters and span timeline.
 *
 * Returns the uninstall function. Installing twice is safe but pointless — the second wrapper
 * would simply see an already-commented statement and leave it alone.
 */
export function installSqlCommentHook(sequelize: Sequelize): () => void {
  const original = sequelize.query.bind(sequelize) as QueryFunction;

  const wrapped: QueryFunction = async (sql: unknown, options?: unknown): Promise<unknown> => {
    const trace = TraceContext.current();
    if (trace === undefined) return original(sql, options);

    const comment = sqlComment(trace.correlationId);
    const commented = comment === null ? sql : withComment(sql, comment);

    const startedAtNs = process.hrtime.bigint();
    try {
      return await original(commented, options);
    } finally {
      const durationMs = Number(process.hrtime.bigint() - startedAtNs) / 1e6;
      trace.db.queryCount += 1;
      trace.db.totalMs = Math.round((trace.db.totalMs + durationMs) * 1e3) / 1e3;
      recordSpan(`${DB_SPAN_PREFIX}${verbOf(sql)}`, durationMs, 'ok', tableAttributes(sql));
    }
  };

  // The two casts are the price of wrapping a method with fourteen overloads. They assert only
  // that the wrapper has the same call signature as the original, which the line above and the
  // delegation inside `wrapped` both hold to (R8 — no `any` is introduced; `unknown` is used).
  const restore = sequelize.query;
  (sequelize as unknown as { query: QueryFunction }).query = wrapped;

  return () => {
    (sequelize as unknown as { query: typeof restore }).query = restore;
  };
}

/**
 * `/* cid=<id> *​/` for a well-formed id, or `null`.
 *
 * The charset (`^[A-Za-z0-9_-]{8,64}$`, 08-OBSERVABILITY.md §1) is what makes `*​/` impossible
 * inside the comment, so the returned string is always exactly one balanced comment.
 */
export function sqlComment(correlationId: string): string | null {
  if (!CORRELATION_ID_PATTERN.test(correlationId)) return null;
  return `/* cid=${correlationId} */`;
}

/** Prepends `comment` to a statement in either of the two forms `sequelize.query` accepts. */
export function withComment(sql: unknown, comment: string): unknown {
  if (typeof sql === 'string') return `${comment} ${sql}`;

  if (isStatementObject(sql)) {
    // A copy, never a mutation: the caller may be reusing the object (Sequelize's own
    // `QueryInterface` builds one per call, but a Wave 3 service might not), and a statement that
    // accumulated one comment per execution would grow without bound.
    return { ...sql, query: `${comment} ${sql.query}` };
  }

  // An unrecognised shape is passed through untouched. A tracing layer that could reject a
  // statement it did not understand would be a tracing layer that can take the portal down.
  return sql;
}

// --- internals ---------------------------------------------------------------------------------

function isStatementObject(value: unknown): value is StatementObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StatementObject).query === 'string'
  );
}

/** The statement's leading keyword, for the span name. `query` when it is anything else. */
function verbOf(sql: unknown): string {
  const text = textOf(sql);
  const verb = VERB_PATTERN.exec(text)?.[1]?.toLowerCase();
  return verb !== undefined && KNOWN_VERBS.has(verb) ? verb : UNKNOWN_SQL_VERB;
}

/**
 * `{ table }` when the statement names one recognisably, `undefined` otherwise.
 *
 * **Only the identifier.** The statement text itself is never recorded as a span attribute: spans
 * are written to log lines, and a statement can carry literal values that a bind parameter would
 * have kept out (`redact-sql.ts` makes the same point for Sequelize's own query logger).
 */
function tableAttributes(sql: unknown): { table: string } | undefined {
  const match = TABLE_PATTERN.exec(textOf(sql));
  return match === null ? undefined : { table: match[1] };
}

function textOf(sql: unknown): string {
  if (typeof sql === 'string') return sql;
  return isStatementObject(sql) ? sql.query : '';
}
