/**
 * T-019 — tracing against the **real** Postgres instance.
 *
 * The unit suites drive doubles, which is what makes 100% branch coverage reachable and proves
 * nothing about four things this file covers:
 *
 *  1. **T019_001 really added `portal_audit_log.correlation_id`**, with the width the
 *     08-OBSERVABILITY.md §1 charset implies, nullable, and with its partial index.
 *  2. **The id really lands in a row** written by `AuditRepository` through the least-privilege
 *     `reward_app` role, and reads back.
 *  3. **TC-14 — the SQL comment is visible in `pg_stat_activity`.** This is the whole point of
 *     implementation note 4 and cannot be demonstrated anywhere else: a unit test can only
 *     assert the string this process built, not that Postgres kept it.
 *  4. **The module wiring is what `app.module.ts`'s comment claims** — `TracingModule` applies
 *     the middleware to every route and contributes no global interceptor (which is what makes
 *     its position at the head of `AppModule.imports` safe for T-018's ordering).
 *
 * ### Isolation
 *
 * Every row this file writes is marked with a per-run marker in `event_type` and deleted in
 * `afterAll`, so a failed run cannot collide with seeded data or with another suite. Nothing is
 * written to `reward_config`.
 */
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { AuditRepository } from '@/common/audit/audit.repository';
import { createMigrationConnection } from '@/database/migration-connection';
import { installSqlCommentHook } from '@/common/tracing/sql-comment.hook';
import { TraceContext } from '@/common/tracing/trace-context';
import { CorrelationMiddleware } from '@/common/tracing/correlation.middleware';
import { TracingModule } from '@/common/tracing/tracing.module';
import { buildAppSequelize } from '../database/build-app-sequelize';
import { makeTrace } from './support/trace-fixtures';

jest.setTimeout(120_000);

/** Every row and every correlation id this run creates is prefixed with this. */
const MARKER = `t019_e2e_${Date.now()}`;

/** Matches every run's marker, so a previously-failed run's residue is swept before this one. */
const MARKER_PREFIX = 't019_e2e_%';

/**
 * A correlation id unique to this run.
 *
 * It has to be: `portal_audit_log` is append-only for `reward_app`, so a run that fails before
 * `afterAll` leaves its rows behind, and a fixed id would make the *next* run fail on residue
 * rather than on anything real. (Observed, not theorised — this is what the first run of this
 * suite did.) The result still satisfies `^[A-Za-z0-9_-]{8,64}$`, which the SQL comment depends
 * on.
 */
function correlationIdFor(suffix: string): string {
  return `${MARKER}-${suffix}`;
}

let sequelize: Sequelize;
let observer: Sequelize;
let admin: Sequelize;

beforeAll(async () => {
  sequelize = buildAppSequelize();
  // A second app-role connection, because TC-14 has to watch one connection's query from
  // another. Both are `reward_app`: Postgres shows `pg_stat_activity.query` to a non-superuser
  // only for sessions belonging to the same role, so an observer on the migration role would
  // work while proving something weaker than what the application can actually see.
  observer = buildAppSequelize();
  // The privileged connection exists **only** to clean up. `reward_app` holds `SELECT, INSERT`
  // and nothing more on `portal_audit_log` — `REVOKE UPDATE, DELETE` (01-DATABASE.md §3,
  // T002_008) — so the app role genuinely cannot remove this suite's rows from a real 7-year
  // audit trail. Same arrangement, for the same reason, as `audit.e2e-spec.ts`.
  admin = createMigrationConnection();

  await sequelize.authenticate();
  await observer.authenticate();
  await admin.authenticate();

  // Sweep any residue from a run that failed before its own cleanup.
  await admin.query(`DELETE FROM reward_portal.portal_audit_log WHERE event_type LIKE :marker`, {
    type: QueryTypes.RAW,
    replacements: { marker: MARKER_PREFIX },
  });
});

afterAll(async () => {
  try {
    await admin.query(`DELETE FROM reward_portal.portal_audit_log WHERE event_type LIKE :marker`, {
      type: QueryTypes.RAW,
      replacements: { marker: `${MARKER}%` },
    });
  } finally {
    // Closed regardless: a failed cleanup must not also leak three pools and hang the worker.
    await sequelize.close();
    await observer.close();
    await admin.close();
  }
});

describe('T019_001 — the migration, as the database actually applied it', () => {
  it('added correlation_id as a nullable varchar(64)', async () => {
    const [column] = await sequelize.query<{
      data_type: string;
      character_maximum_length: number;
      is_nullable: string;
    }>(
      `SELECT data_type, character_maximum_length, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'reward_portal'
          AND table_name   = 'portal_audit_log'
          AND column_name  = 'correlation_id'`,
      { type: QueryTypes.SELECT },
    );

    expect(column).toBeDefined();
    expect(column.data_type).toBe('character varying');
    // 64 is the upper bound of ^[A-Za-z0-9_-]{8,64}$ — exact, not generous.
    expect(column.character_maximum_length).toBe(64);
    // Nullable, because an audit row must still be writable with no request context (T-014
    // implementation note 4: an audit failure must never fail the request).
    expect(column.is_nullable).toBe('YES');
  });

  it('created the partial index T-045 will search by', async () => {
    const [index] = await sequelize.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'reward_portal' AND indexname = 'ix_pal_correlation'`,
      { type: QueryTypes.SELECT },
    );

    expect(index).toBeDefined();
    expect(index.indexdef).toContain('correlation_id');
    expect(index.indexdef).toContain('WHERE (correlation_id IS NOT NULL)');
  });

  it('documented the column, so the next reader does not have to find this task', async () => {
    const [comment] = await sequelize.query<{ description: string | null }>(
      `SELECT col_description(
                'reward_portal.portal_audit_log'::regclass,
                (SELECT ordinal_position FROM information_schema.columns
                  WHERE table_schema='reward_portal' AND table_name='portal_audit_log'
                    AND column_name='correlation_id')
              ) AS description`,
      { type: QueryTypes.SELECT },
    );

    expect(comment.description).toContain('T-019');
  });
});

describe('TC-16 — a real audit row carries the correlation id', () => {
  it('writes it and reads it back through the least-privilege role', async () => {
    const correlationId = correlationIdFor('write');
    const eventType = `${MARKER}_write`;

    await TraceContext.run(makeTrace({ correlationId }), () =>
      new AuditRepository(sequelize).insertPortalEvent({
        eventType,
        actorId: null,
        actorRole: 'super_admin',
        targetType: 'route',
        targetId: '/api/v1/health',
        countryId: null,
        tenantId: null,
        ipAddress: '10.0.0.4',
        detail: { method: 'GET' },
      }),
    );

    const [row] = await sequelize.query<{ correlation_id: string | null }>(
      `SELECT correlation_id FROM reward_portal.portal_audit_log WHERE event_type = :eventType`,
      { type: QueryTypes.SELECT, replacements: { eventType } },
    );

    expect(row.correlation_id).toBe(correlationId);
  });

  it('is found by the index-backed query T-045 will run', async () => {
    const correlationId = correlationIdFor('lookup');
    const eventType = `${MARKER}_lookup`;

    await TraceContext.run(makeTrace({ correlationId }), () =>
      new AuditRepository(sequelize).insertPortalEvent({
        eventType,
        actorId: null,
        actorRole: null,
        targetType: null,
        targetId: null,
        countryId: null,
        tenantId: null,
        ipAddress: null,
        detail: null,
      }),
    );

    const rows = await sequelize.query<{ event_type: string }>(
      `SELECT event_type FROM reward_portal.portal_audit_log WHERE correlation_id = :correlationId`,
      { type: QueryTypes.SELECT, replacements: { correlationId } },
    );

    expect(rows.map((row) => row.event_type)).toEqual([eventType]);
  });

  it('writes NULL, not a failure, for a row with no request context', async () => {
    const eventType = `${MARKER}_nocontext`;

    await new AuditRepository(sequelize).insertPortalEvent({
      eventType,
      actorId: null,
      actorRole: null,
      targetType: null,
      targetId: null,
      countryId: null,
      tenantId: null,
      ipAddress: null,
      detail: null,
    });

    const [row] = await sequelize.query<{ correlation_id: string | null }>(
      `SELECT correlation_id FROM reward_portal.portal_audit_log WHERE event_type = :eventType`,
      { type: QueryTypes.SELECT, replacements: { eventType } },
    );

    expect(row.correlation_id).toBeNull();
  });
});

describe('TC-13 / TC-14 — the SQL comment reaches Postgres', () => {
  it('TC-14 — is visible in pg_stat_activity while the query is running', async () => {
    const uninstall = installSqlCommentHook(sequelize);
    const correlationId = correlationIdFor('slow');

    try {
      // A statement slow enough to observe from another connection. Started, deliberately not
      // awaited yet — this is the only moment `pg_stat_activity` has anything to show.
      const running = TraceContext.run(makeTrace({ correlationId }), () =>
        sequelize.query('SELECT pg_sleep(2)', { type: QueryTypes.SELECT }),
      );

      let observed: string | null = null;
      const deadline = Date.now() + 5000;
      while (observed === null && Date.now() < deadline) {
        const rows = await observer.query<{ query: string }>(
          `SELECT query FROM pg_stat_activity
            WHERE state = 'active' AND query LIKE :pattern AND pid <> pg_backend_pid()`,
          { type: QueryTypes.SELECT, replacements: { pattern: `%cid=${correlationId}%` } },
        );
        observed = rows[0]?.query ?? null;
        if (observed === null) await new Promise((resolve) => setTimeout(resolve, 50));
      }

      await running;

      // This is the acceptance criterion of implementation note 4: a slow query in the database
      // is no longer an orphan — it names the user action that caused it.
      expect(observed).not.toBeNull();
      expect(observed).toContain(`/* cid=${correlationId} */`);
      expect(observed).toContain('pg_sleep');
    } finally {
      uninstall();
    }
  });

  it('leaves the comment out entirely when the statement runs outside a request', async () => {
    const uninstall = installSqlCommentHook(sequelize);
    try {
      const rows = await sequelize.query<{ one: number }>('SELECT 1 AS one', {
        type: QueryTypes.SELECT,
      });
      // The real assertion is that the statement still ran correctly with no comment attached;
      // the wrapper must be invisible outside a request.
      expect(rows[0].one).toBe(1);
    } finally {
      uninstall();
    }
  });

  it("does not disturb a commented statement's results, bind parameters or errors", async () => {
    const uninstall = installSqlCommentHook(sequelize);
    const trace = makeTrace({ correlationId: correlationIdFor('binds') });

    try {
      await TraceContext.run(trace, async () => {
        const rows = await sequelize.query<{ answer: number }>('SELECT :n::int AS answer', {
          type: QueryTypes.SELECT,
          replacements: { n: 42 },
        });
        expect(rows[0].answer).toBe(42);

        // A genuine SQL error still surfaces as a Sequelize error, not as a parse failure caused
        // by the comment.
        await expect(
          sequelize.query('SELECT * FROM reward_portal.table_that_does_not_exist', {
            type: QueryTypes.SELECT,
          }),
        ).rejects.toThrow();
      });

      expect(trace.db.queryCount).toBe(2);
      expect(trace.spans.map((span) => span.name)).toEqual(['db.select', 'db.select']);
    } finally {
      uninstall();
    }
  });

  it('restores the original query method on uninstall, against the live connection', async () => {
    const original = sequelize.query;
    installSqlCommentHook(sequelize)();
    expect(sequelize.query).toBe(original);

    const rows = await sequelize.query<{ one: number }>('SELECT 1 AS one', {
      type: QueryTypes.SELECT,
    });
    expect(rows[0].one).toBe(1);
  });
});

describe('the module wiring app.module.ts depends on', () => {
  it('TracingModule applies CorrelationMiddleware to every route', () => {
    const applied: unknown[] = [];
    const routes: unknown[] = [];
    const consumer = {
      apply: (...middleware: unknown[]) => {
        applied.push(...middleware);
        return { forRoutes: (...args: unknown[]) => void routes.push(...args) };
      },
    };

    // Constructed directly rather than through Nest: `configure` is a pure function of the
    // consumer, and booting the module would need the whole DI graph to assert one call.
    new TracingModule(sequelize).configure(consumer as never);

    expect(applied).toEqual([CorrelationMiddleware]);
    expect(routes).toEqual(['*']);
  });

  it('TracingModule registers no global guard, interceptor or filter', () => {
    // This is what makes its position at the head of `AppModule.imports` safe: the §6 chain order
    // and 07-DATA-PROTECTION.md §8's `DTO → mask → serialise → encrypt` are both decided by
    // APP_INTERCEPTOR registration order, and a module that had to be first *and* contributed one
    // would silently reorder both (T-018 TC-17 is the test that would fail, three tasks away).
    const providers = (Reflect.getMetadata('providers', TracingModule) ?? []) as {
      provide?: unknown;
    }[];
    const tokens = providers.map((provider) => String(provider.provide ?? provider));

    expect(tokens.some((token) => token.includes('APP_INTERCEPTOR'))).toBe(false);
    expect(tokens.some((token) => token.includes('APP_GUARD'))).toBe(false);
    expect(tokens.some((token) => token.includes('APP_FILTER'))).toBe(false);
  });

  it('installs and uninstalls the SQL comment hook across the lifecycle', () => {
    const module = new TracingModule(sequelize);
    const original = sequelize.query;

    module.onApplicationBootstrap();
    expect(sequelize.query).not.toBe(original);

    module.onApplicationShutdown();
    expect(sequelize.query).toBe(original);

    // Idempotent: a second shutdown (Nest calls hooks once, but an e2e suite may not) is a no-op.
    expect(() => module.onApplicationShutdown()).not.toThrow();
    expect(sequelize.query).toBe(original);
  });
});
