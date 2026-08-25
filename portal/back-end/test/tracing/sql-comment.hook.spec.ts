/**
 * T-019 — SQL comment injection (implementation note 4, 08-OBSERVABILITY.md §2).
 *
 * TC-13 has its form here. TC-14 — the comment actually visible in `pg_stat_activity` — needs a
 * real server and lives in `tracing.e2e-spec.ts`.
 *
 * The security-relevant assertion in this file is the one about `*​/`: the comment is the only
 * place in the codebase where a correlation id is interpolated into a string that is **executed**,
 * so a value that could close the comment early would be a SQL injection with a log-injection
 * cover story. The charset check makes that impossible, and the test drives the impossible case
 * anyway by calling `sqlComment` with a value the middleware would never let through.
 */
import type { Sequelize } from 'sequelize-typescript';
import {
  UNKNOWN_SQL_VERB,
  installSqlCommentHook,
  sqlComment,
  withComment,
} from '@/common/tracing/sql-comment.hook';
import { TraceContext } from '@/common/tracing/trace-context';
import { makeTrace } from './support/trace-fixtures';

interface Executed {
  sql: unknown;
  options: unknown;
}

/** A `Sequelize` double whose `query` records what it was asked to run. */
function fakeSequelize(behaviour: 'resolve' | 'reject' = 'resolve'): {
  sequelize: Sequelize;
  executed: Executed[];
} {
  const executed: Executed[] = [];
  const sequelize = {
    async query(sql: unknown, options: unknown) {
      executed.push({ sql, options });
      if (behaviour === 'reject') throw new Error('database exploded');
      return ['row'];
    },
  } as unknown as Sequelize;
  return { sequelize, executed };
}

describe('sqlComment', () => {
  it('builds exactly one balanced comment from a valid id', () => {
    expect(sqlComment('01J8F3K9QP2M7N')).toBe('/* cid=01J8F3K9QP2M7N */');
  });

  it.each([
    ['a comment terminator', 'abc*/ OR 1=1 --'],
    ['a newline', 'abcdefgh\nDROP TABLE x'],
    ['a quote', "abcdefgh' OR '1'='1"],
    ['a semicolon', 'abcdefgh; DROP TABLE x'],
    ['a bind-parameter colon', 'abcdefgh:evil'],
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
    ['empty', ''],
  ])('refuses to build a comment from %s', (_label, id) => {
    // Defence in depth: `CorrelationMiddleware` already guarantees these never reach here. This
    // is the guard that survives somebody refactoring the middleware.
    expect(sqlComment(id)).toBeNull();
  });

  it('never produces a string containing a comment terminator other than its own', () => {
    const comment = sqlComment('01J8F3K9QP2M7N');
    expect(comment?.indexOf('*/')).toBe(comment!.length - 2);
  });
});

describe('withComment', () => {
  it('prepends to a string statement', () => {
    expect(withComment('SELECT 1', '/* cid=x */')).toBe('/* cid=x */ SELECT 1');
  });

  it('prepends inside a { query, values } statement without mutating the original', () => {
    const original = { query: 'SELECT 1', values: [1] };
    const result = withComment(original, '/* cid=x */') as { query: string; values: number[] };

    expect(result.query).toBe('/* cid=x */ SELECT 1');
    expect(result.values).toEqual([1]);
    expect(original.query).toBe('SELECT 1');
  });

  it('passes an unrecognised shape through untouched', () => {
    const weird = { notAQuery: true };
    expect(withComment(weird, '/* cid=x */')).toBe(weird);
    expect(withComment(null, '/* cid=x */')).toBeNull();
    expect(withComment(42, '/* cid=x */')).toBe(42);
  });
});

describe('installSqlCommentHook', () => {
  it('TC-13 — every statement issued inside a request carries /* cid=… */', async () => {
    const { sequelize, executed } = fakeSequelize();
    installSqlCommentHook(sequelize);
    const trace = makeTrace({ correlationId: 'op-1234-abcd' });

    await TraceContext.run(trace, async () => {
      await sequelize.query('SELECT * FROM reward_portal.portal_users WHERE id = :id', {
        replacements: { id: 1 },
      });
    });

    expect(executed[0].sql).toBe(
      '/* cid=op-1234-abcd */ SELECT * FROM reward_portal.portal_users WHERE id = :id',
    );
    // The options are passed through byte-identically — a tracing layer must not perturb a query.
    expect(executed[0].options).toEqual({ replacements: { id: 1 } });
  });

  it('adds nothing outside a request, so migrations and introspection are untouched', async () => {
    const { sequelize, executed } = fakeSequelize();
    installSqlCommentHook(sequelize);

    await sequelize.query('SELECT table_name FROM information_schema.tables');

    expect(executed[0].sql).toBe('SELECT table_name FROM information_schema.tables');
  });

  it('counts queries and accumulates their time on the trace', async () => {
    const { sequelize } = fakeSequelize();
    installSqlCommentHook(sequelize);
    const trace = makeTrace();

    await TraceContext.run(trace, async () => {
      await sequelize.query('SELECT 1');
      await sequelize.query('SELECT 2');
      await sequelize.query('SELECT 3');
    });

    expect(trace.db.queryCount).toBe(3);
    expect(trace.db.totalMs).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ['SELECT id FROM reward_portal.portal_users', 'db.select', 'reward_portal.portal_users'],
    [
      'INSERT INTO reward_portal.portal_audit_log (a) VALUES (1)',
      'db.insert',
      'reward_portal.portal_audit_log',
    ],
    ['UPDATE reward_config.tenants SET a = 1', 'db.update', 'reward_config.tenants'],
    ['DELETE FROM "quoted_table" WHERE id = 1', 'db.delete', '"quoted_table"'],
  ])('records %s as a %s span naming the table', async (sql, spanName, table) => {
    const { sequelize } = fakeSequelize();
    installSqlCommentHook(sequelize);
    const trace = makeTrace();

    await TraceContext.run(trace, () => sequelize.query(sql));

    expect(trace.spans[0].name).toBe(spanName);
    expect(trace.spans[0].attributes).toEqual({ table });
  });

  it('falls back to db.query with no table attribute when it cannot tell', async () => {
    const { sequelize } = fakeSequelize();
    installSqlCommentHook(sequelize);
    const trace = makeTrace();

    await TraceContext.run(trace, () => sequelize.query('BEGIN'));

    expect(trace.spans[0].name).toBe(`db.${UNKNOWN_SQL_VERB}`);
    expect(trace.spans[0]).not.toHaveProperty('attributes');
  });

  it('records a { query } statement object too', async () => {
    const { sequelize, executed } = fakeSequelize();
    installSqlCommentHook(sequelize);
    const trace = makeTrace({ correlationId: 'objectform1' });

    await TraceContext.run(trace, () =>
      sequelize.query({ query: 'SELECT 1 FROM t', values: [] } as unknown as string),
    );

    expect((executed[0].sql as { query: string }).query).toBe(
      '/* cid=objectform1 */ SELECT 1 FROM t',
    );
    expect(trace.spans[0].name).toBe('db.select');
  });

  it('tolerates a statement of an unrecognised shape without failing the query', async () => {
    // Sequelize's own typings say `string | { query, values }`, but this wrapper sits in front of
    // every call in the process and a tracing layer that could throw on an unexpected argument
    // would be a tracing layer that can take the portal down.
    const { sequelize, executed } = fakeSequelize();
    installSqlCommentHook(sequelize);
    const trace = makeTrace();

    await TraceContext.run(trace, async () => {
      await sequelize.query(null as unknown as string);
      await sequelize.query(42 as unknown as string);
    });

    expect(executed.map((entry) => entry.sql)).toEqual([null, 42]);
    expect(trace.spans.map((span) => span.name)).toEqual([
      `db.${UNKNOWN_SQL_VERB}`,
      `db.${UNKNOWN_SQL_VERB}`,
    ]);
    expect(trace.spans[0]).not.toHaveProperty('attributes');
  });

  it('never records a span attribute containing the statement or its literals', async () => {
    const { sequelize } = fakeSequelize();
    installSqlCommentHook(sequelize);
    const trace = makeTrace();

    await TraceContext.run(trace, () =>
      sequelize.query("SELECT * FROM users WHERE email = 'jane@example.com'"),
    );

    expect(JSON.stringify(trace.spans[0])).not.toContain('jane@example.com');
  });

  it('still counts and records a failing query, and rethrows it unchanged', async () => {
    const { sequelize } = fakeSequelize('reject');
    installSqlCommentHook(sequelize);
    const trace = makeTrace();

    await TraceContext.run(trace, async () => {
      await expect(sequelize.query('SELECT 1')).rejects.toThrow('database exploded');
    });

    expect(trace.db.queryCount).toBe(1);
    expect(trace.spans).toHaveLength(1);
  });

  it('uninstalls cleanly, restoring the original method identity', async () => {
    const { sequelize, executed } = fakeSequelize();
    const original = sequelize.query;

    const uninstall = installSqlCommentHook(sequelize);
    expect(sequelize.query).not.toBe(original);

    uninstall();
    expect(sequelize.query).toBe(original);

    await TraceContext.run(makeTrace(), () => sequelize.query('SELECT 1'));
    expect(executed[0].sql).toBe('SELECT 1');
  });

  it('skips the comment when the ambient id is somehow malformed, rather than injecting it', async () => {
    // Unreachable through the middleware; reachable if a future caller builds a trace by hand.
    const { sequelize, executed } = fakeSequelize();
    installSqlCommentHook(sequelize);

    await TraceContext.run(makeTrace({ correlationId: 'bad*/id' }), () =>
      sequelize.query('SELECT 1'),
    );

    expect(executed[0].sql).toBe('SELECT 1');
  });
});
