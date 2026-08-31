/**
 * T-156 regression suite — proves `T105_001_seed_rule_categories.ts`'s `up()`/`down()` against
 * a genuinely fresh `reward_config` schema (no `tenants`, no `rule_categories`, nothing else
 * seeded), the exact precondition `test/database-cli/first-run.e2e-spec.ts` (T-057, owned by a
 * different task — not this suite) exercises for the whole migration chain. This file is scoped
 * to `test/database/**`, this task's own owned test path, and to just the one migration this
 * task owns — it does not run the full `db:migrate` chain (that would also hit `T105_002`'s own,
 * separately-filed, out-of-scope defect — see this task's completion report).
 *
 * ### Why a dedicated scratch database, not the shared dev database
 *
 * Every other `test/database/*.e2e-spec.ts` in this project (see `t004-seeds-bootstrap` and
 * `t005-versioning-schema`) runs against the shared live dev database via
 * `createMigrationConnection()` — deliberately, because this dev machine has no working Docker
 * daemon to spin up an isolated instance instead (same convention those files' own headers
 * document). That is exactly the wrong fixture for *this* defect: the shared dev database has
 * held a real `tenant_id=1` row since before this project's own work began (T-004/CLAUDE.md's
 * CC-00 finding), so the one precondition this bug needs — zero `reward_config.tenants` rows —
 * can never occur there. Reproducing (and regression-guarding) it needs a database this suite
 * creates and fully controls, the same disposable-scratch-database strategy
 * `test/database-cli/first-run.e2e-spec.ts` established for the identical reason, duplicated
 * narrowly here (not imported — that file is owned by a different task, and `e2e/` utilities of
 * the same shape are a separate npm workspace unreachable from here, per that file's own header).
 *
 * Only `reward_config_postgres.sql` is loaded — no `reward_portal` schema, no other migration —
 * because `T105_001` touches only `reward_config.{countries,tenants,rule_categories,
 * rule_sub_categories}`. Skipping the rest keeps this suite fast and free of any dependency on
 * migrations this task does not own.
 */
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { up, down } from '@/database/migrations/T105_001_seed_rule_categories';

const BACK_END_DIR = path.join(__dirname, '..', '..');
const PORTAL_ROOT = path.join(BACK_END_DIR, '..');
const REWARD_CONFIG_SQL_PATH = path.join(
  PORTAL_ROOT,
  '..',
  'database',
  'reward_config',
  'reward_config_postgres.sql',
);

const DB_HOST = process.env.E2E_LOCAL_DB_HOST ?? 'localhost';
const DB_PORT = Number(process.env.E2E_LOCAL_DB_PORT ?? 5432);
const MAINTENANCE_DATABASE = 'postgres';

/** Same lookup `CLAUDE.md` documents and `first-run.e2e-spec.ts` already uses — the
 * migration/superuser credential, read from this machine's own Keychain, never guessed or
 * hardcoded (R4). */
function resolveSuperuserPassword(): string {
  const fromEnv = process.env.E2E_LOCAL_DB_SUPERUSER_PASSWORD;
  if (fromEnv) return fromEnv;
  if (process.platform !== 'darwin') {
    throw new Error(
      'No Keychain on this platform for the local Postgres superuser password; set ' +
        'E2E_LOCAL_DB_SUPERUSER_PASSWORD explicitly.',
    );
  }
  return execFileSync(
    'security',
    ['find-generic-password', '-a', 'pgAdmin4-PostgreSQL 16-1', '-s', 'pgAdmin4', '-w'],
    { encoding: 'utf8' },
  ).trim();
}

function withMaintenanceClient<T>(
  superuserPassword: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    host: DB_HOST,
    port: DB_PORT,
    database: MAINTENANCE_DATABASE,
    user: 'postgres',
    password: superuserPassword,
  });
  return client
    .connect()
    .then(() => fn(client))
    .finally(() => client.end());
}

interface Snapshot {
  tenants: number;
  countries: number;
  categories: number;
  subCategories: number;
}

async function snapshot(sequelize: Sequelize): Promise<Snapshot> {
  const count = async (table: string): Promise<number> => {
    const [row] = (await sequelize.query(
      `SELECT count(*)::int AS count FROM reward_config.${table}`,
      { type: QueryTypes.SELECT },
    )) as unknown as [{ count: number }];
    return row.count;
  };
  return {
    tenants: await count('tenants'),
    countries: await count('countries'),
    categories: await count('rule_categories'),
    subCategories: await count('rule_sub_categories'),
  };
}

describe('T-156 — T105_001 rule-category seed on a genuinely fresh reward_config schema', () => {
  let superuserPassword: string;
  let scratchDb: string;
  let sequelize: Sequelize;

  beforeAll(async () => {
    superuserPassword = resolveSuperuserPassword();
    scratchDb = `t156_scratch_${String(Date.now())}_${randomBytes(3).toString('hex')}`;

    await withMaintenanceClient(superuserPassword, async (client) => {
      await client.query(`CREATE DATABASE "${scratchDb}"`);
    });

    const rewardConfigSql = readFileSync(REWARD_CONFIG_SQL_PATH, 'utf8');
    const scratchClient = new Client({
      host: DB_HOST,
      port: DB_PORT,
      database: scratchDb,
      user: 'postgres',
      password: superuserPassword,
    });
    await scratchClient.connect();
    try {
      await scratchClient.query(rewardConfigSql);
    } finally {
      await scratchClient.end();
    }

    sequelize = new Sequelize({
      dialect: 'postgres',
      host: DB_HOST,
      port: DB_PORT,
      database: scratchDb,
      username: 'postgres',
      password: superuserPassword,
      logging: false,
    });
    await sequelize.authenticate();
  }, 60_000);

  afterAll(async () => {
    await sequelize?.close();
    if (scratchDb === undefined) return;
    await withMaintenanceClient(superuserPassword, async (client) => {
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [scratchDb],
      );
      await client.query(`DROP DATABASE IF EXISTS "${scratchDb}"`);
    });
  }, 30_000);

  it('TC-1: the schema starts with zero tenants — the exact precondition the reported defect needs', async () => {
    const before = await snapshot(sequelize);
    expect(before).toEqual({ tenants: 0, countries: 0, categories: 0, subCategories: 0 });
  });

  it('TC-2: up() succeeds on the empty schema — no fk_rc_tenant violation — and seeds all 6 sub-categories', async () => {
    await expect(up({ context: sequelize })).resolves.toBeUndefined();

    const after = await snapshot(sequelize);
    expect(after).toEqual({ tenants: 1, countries: 1, categories: 3, subCategories: 6 });

    const tenant = await sequelize.query<{ code: string; name: string }>(
      `SELECT code, name FROM reward_config.tenants`,
      { type: QueryTypes.SELECT },
    );
    expect(tenant).toEqual([{ code: 'T156-BOOTSTRAP', name: 'T-156 Bootstrap Tenant' }]);

    // The full 6-row set — includes SCHEDULE/TIME_WINDOW_CHECK, which a naive fix (bootstrap
    // only tenants/countries, leave the pre-T-156 hardcoded SCHEDULE-category JOIN untouched)
    // would silently drop to 5/6 with no error (reproduced during this task's own diagnosis).
    const subCategories = await sequelize.query<{
      category_code: string;
      sub_category_code: string;
    }>(
      `SELECT c.category_code, sc.sub_category_code
         FROM reward_config.rule_sub_categories sc
         JOIN reward_config.rule_categories c ON c.id = sc.category_id
        ORDER BY 1, 2`,
      { type: QueryTypes.SELECT },
    );
    expect(subCategories).toEqual([
      { category_code: 'AGGREGATE', sub_category_code: 'TXN_COUNT_CHECK' },
      { category_code: 'AGGREGATE', sub_category_code: 'TXN_SUM_CHECK' },
      { category_code: 'COMPONENT', sub_category_code: 'COMP_COUNT_CHECK' },
      { category_code: 'COMPONENT', sub_category_code: 'COMP_DURATION_CHECK' },
      { category_code: 'COMPONENT', sub_category_code: 'COMP_STATUS_CHECK' },
      { category_code: 'SCHEDULE', sub_category_code: 'TIME_WINDOW_CHECK' },
    ]);
  });

  it('TC-3 (idempotency): a second up() inserts zero new rows', async () => {
    const before = await snapshot(sequelize);
    await up({ context: sequelize });
    const after = await snapshot(sequelize);
    expect(after).toEqual(before);
  });

  it(
    'TC-4/R7 (the regression this task itself found): a down() -> up() round trip still lands ' +
      'exactly 6 sub-categories, even though reward_config.tenants.id is a generated-always ' +
      "identity column DELETE never rewinds — proven to fail on this task's own first fix " +
      'attempt (a literal tenant_id = 1) once the identity sequence had already advanced past ' +
      '1; TARGET_TENANT_ID_SQL in the migration under test resolves the tenant dynamically by ' +
      'code instead. Reverting that resolver back to the literal `1` turns this red again — see ' +
      "this task's completion report for the exact reproduction.",
    async () => {
      await down({ context: sequelize });
      const afterDown = await snapshot(sequelize);
      expect(afterDown).toEqual({ tenants: 0, countries: 0, categories: 0, subCategories: 0 });

      await up({ context: sequelize });
      const afterSecondUp = await snapshot(sequelize);
      expect(afterSecondUp).toEqual({ tenants: 1, countries: 1, categories: 3, subCategories: 6 });

      const subCategoryCount = await sequelize.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM reward_config.rule_sub_categories`,
        { type: QueryTypes.SELECT },
      );
      expect(subCategoryCount[0].count).toBe(6);
    },
  );

  it('TC-5 (adjacent behaviour unchanged): once a real tenant already occupies id=1, up() bootstraps nothing and attaches categories to that real tenant, exactly the pre-T-156 behaviour', async () => {
    // Clean slate, then simulate "a real environment" — a tenant already at id=1, the
    // convention every environment this migration ran against before T-156 always had. The
    // earlier tests in this file already advanced `tenants_id_seq` past 1 (TC-4 deliberately
    // proves a down()/up() cycle survives exactly that) — `generated always as identity`
    // sequences are never rewound by `DELETE`, only by an explicit `RESTART`, so this test
    // resets it itself to reproduce id=1 deterministically, rather than depending on
    // whatever value happens to be next (which earlier tests already showed is not always 1).
    await down({ context: sequelize });
    await sequelize.query(`ALTER SEQUENCE reward_config.tenants_id_seq RESTART WITH 1;`, {
      type: QueryTypes.RAW,
    });
    await sequelize.query(`ALTER SEQUENCE reward_config.countries_id_seq RESTART WITH 1;`, {
      type: QueryTypes.RAW,
    });

    await sequelize.query(
      `INSERT INTO reward_config.countries
           (code, name, timezone, currency_code, dialing_code, is_hq, status)
       VALUES ('XX', 'Real Country', 'UTC', 'USD', '+1', true, 'active')`,
      { type: QueryTypes.RAW },
    );
    await sequelize.query(
      `INSERT INTO reward_config.tenants (code, name, country_id, status)
       SELECT 'REAL-TENANT-1', 'Real Tenant', c.id, 'active'
       FROM reward_config.countries c WHERE c.code = 'XX'`,
      { type: QueryTypes.RAW },
    );
    const [realTenant] = await sequelize.query<{ id: number; code: string }>(
      `SELECT id, code FROM reward_config.tenants`,
      { type: QueryTypes.SELECT },
    );
    expect(realTenant.id).toBe(1); // first row after the explicit sequence reset above

    await up({ context: sequelize });

    // No bootstrap tenant/country ever appears once a real tenant already holds id=1.
    const bootstrapTenants = await sequelize.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM reward_config.tenants WHERE code = 'T156-BOOTSTRAP'`,
      { type: QueryTypes.SELECT },
    );
    expect(bootstrapTenants[0].count).toBe(0);
    const bootstrapCountries = await sequelize.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM reward_config.countries WHERE code = 'ZZ'`,
      { type: QueryTypes.SELECT },
    );
    expect(bootstrapCountries[0].count).toBe(0);

    // Categories attach to the real tenant, not a bootstrap one.
    const categoryTenants = await sequelize.query<{ tenant_id: number }>(
      `SELECT DISTINCT tenant_id FROM reward_config.rule_categories`,
      { type: QueryTypes.SELECT },
    );
    expect(categoryTenants).toEqual([{ tenant_id: realTenant.id }]);

    // Clean up this test's own fixtures so later tests in this file (there are none after this
    // one) or a re-run of this suite start from a known state.
    await down({ context: sequelize });
    await sequelize.query(`DELETE FROM reward_config.tenants WHERE code = 'REAL-TENANT-1'`, {
      type: QueryTypes.RAW,
    });
    await sequelize.query(`DELETE FROM reward_config.countries WHERE code = 'XX'`, {
      type: QueryTypes.RAW,
    });
  });
});
