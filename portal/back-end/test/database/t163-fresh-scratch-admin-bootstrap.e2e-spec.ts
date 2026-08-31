/**
 * T-163 regression suite — proves `T105_002_seed_sample_rule_masters.ts`'s `up()`/`down()`
 * against the exact precondition `test/database-cli/first-run.e2e-spec.ts` (T-057, owned by a
 * different task) and `test/database/t156-fresh-scratch-tenant-bootstrap.e2e-spec.ts` (T-156,
 * also owned by this agent but a different, already-`review`ed task) both exercise: a genuinely
 * fresh `reward_config` schema (`reward_config_postgres.sql` + the full real migration chain,
 * nothing else seeded). T-156 fixed `T105_001`'s half of that chain (no `tenants` row to attach
 * `rule_categories` to); this suite proves the second, deeper defect T-156's own verification
 * found one migration further down — `T105_002` assuming a real `reward_config.admin_users` row
 * and a real `TRANSACTION`/`GENERAL` category already exist — is now fixed too.
 *
 * Two independent fixtures, for two different properties:
 *
 *  - **`describe('fresh scratch database', ...)`** — a disposable Postgres database this suite
 *    creates and drops itself, exactly `t156`'s own strategy (duplicated narrowly, not imported,
 *    for the same reason that file's header gives: `e2e/` utilities of the same shape are a
 *    separate npm workspace unreachable from here). Runs the *entire* real migration chain via
 *    the real CLI (`migrate.ts up`) — the only way to get `T105_002` the ~30 migrations of
 *    prerequisite schema (`rule_resolvers`, `rule_versions`, `rule_categories`, the relaxed
 *    `rule_master.tenant_id`, ...) it depends on, none of which this task owns or should
 *    reconstruct by hand. Proves the reported defect is gone end to end, then imports
 *    `T105_002`'s own `up()`/`down()` directly against that same database to prove R7 ("every
 *    migration has a working `down()`... proven by migrate → rollback → migrate") in isolation
 *    from the ~30 unrelated migrations around it.
 *
 *  - **`describe('adjacent behaviour — the shared dev database', ...)`** — `T105_002` already
 *    ran, months ago, against the shared live dev database this machine's other e2e suites also
 *    use (real `admin_users`, real `TRANSACTION`/`GENERAL`) — the same disclosed
 *    shared-database convention `t004-seeds-bootstrap.e2e-spec.ts` / `t005-versioning-schema
 *    .e2e-spec.ts` already use in this exact folder (no Docker daemon on this machine to isolate
 *    instead — see those files' own headers). Calling `up()` again there must be a pure no-op —
 *    proving this fix's new bootstrap branches (admin_users/tenant_api_keys/TRANSACTION/GENERAL)
 *    never fire on an environment that already has real data, i.e. every environment this
 *    migration ran against before T-163.
 */
import 'reflect-metadata';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { up, down } from '@/database/migrations/T105_002_seed_sample_rule_masters';

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

const SEED_RULE_CODES = [
  'RULE_TXN_TYPE_001',
  'RULE_TXN_AMOUNT_MIN',
  'RULE_PRODUCT_TYPE_001',
  'RULE_COMP_COMPLETED_001',
  'RULE_COMP_NOT_COMPLETED_001',
  'RULE_TIME_WINDOW',
  'RULE_TXN_COUNT',
];

/** Same lookup `CLAUDE.md` documents and `t156`'s own suite uses — the migration/superuser
 * credential, read from this machine's own Keychain, never guessed or hardcoded (R4). */
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

/** Same `spawnSync('npx', ['ts-node', ...])` shape `first-run.e2e-spec.ts`/`t057` already use —
 * runs the real migration CLI as a real child process, exactly as an operator would. */
function runMigrateUp(env: NodeJS.ProcessEnv): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    'npx',
    ['ts-node', '-T', '-r', 'tsconfig-paths/register', 'src/database/cli/migrate.ts', 'up'],
    { cwd: BACK_END_DIR, env, encoding: 'utf8', timeout: 120_000 },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('T-163 — T105_002 sample-rule seed on a genuinely fresh reward_config/reward_portal database', () => {
  let superuserPassword: string;
  let scratchDb: string;
  let sequelize: Sequelize;

  beforeAll(async () => {
    superuserPassword = resolveSuperuserPassword();
    scratchDb = `t163_scratch_${String(Date.now())}_${randomBytes(3).toString('hex')}`;

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

    // T-163 (TC-1/TC-2): the full real migration chain, via the real CLI — the exact sequence
    // `first-run.e2e-spec.ts` runs, and the exact sequence that failed with "T105_002: no
    // reward_config.admin_users row found to attribute seed rules to" before this task's fix
    // (reproduced by hand against this same fixture with the fix reverted — see this task's
    // completion report for the transcript).
    const migrateEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'development',
      DB_HOST,
      DB_PORT: String(DB_PORT),
      DB_NAME: scratchDb,
      DB_SSL: 'false',
      DB_APP_USERNAME: 'postgres',
      DB_APP_PASSWORD: superuserPassword,
      DB_MIGRATION_USERNAME: 'postgres',
      DB_MIGRATION_PASSWORD: superuserPassword,
    };
    const migrate = runMigrateUp(migrateEnv);
    if (migrate.status !== 0) {
      throw new Error(
        `db:migrate up failed on the fresh scratch database:\n${migrate.stdout}\n${migrate.stderr}`,
      );
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
  }, 180_000);

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

  it('TC-2: the full migration chain — including T105_002 — applies cleanly on a from-scratch database', async () => {
    const admin = await sequelize.query<{ email: string; role: string }>(
      `SELECT email, role FROM reward_config.admin_users`,
      { type: QueryTypes.SELECT },
    );
    expect(admin).toEqual([{ email: 'bootstrap-admin@t163.invalid', role: 'super_admin' }]);

    const seededRules = await sequelize.query<{ rule_code: string; status: string }>(
      `SELECT rule_code, status FROM reward_config.rule_master
        WHERE rule_code IN (:codes) ORDER BY rule_code`,
      { type: QueryTypes.SELECT, replacements: { codes: SEED_RULE_CODES } },
    );
    expect(seededRules.map((r) => r.rule_code)).toEqual([...SEED_RULE_CODES].sort());
    expect(seededRules.every((r) => r.status === 'active')).toBe(true);

    const versions = await sequelize.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM reward_config.rule_versions rv
         JOIN reward_config.rule_master rm ON rm.id = rv.rule_id
        WHERE rm.rule_code IN (:codes) AND rv.status = 'draft'`,
      { type: QueryTypes.SELECT, replacements: { codes: SEED_RULE_CODES } },
    );
    expect(versions[0].count).toBe(SEED_RULE_CODES.length);

    const transactionCategory = await sequelize.query<{ category_code: string }>(
      `SELECT category_code FROM reward_config.rule_categories WHERE category_code = 'TRANSACTION'`,
      { type: QueryTypes.SELECT },
    );
    expect(transactionCategory).toHaveLength(1);
    const generalSubCategory = await sequelize.query<{ sub_category_code: string }>(
      `SELECT sc.sub_category_code
         FROM reward_config.rule_sub_categories sc
         JOIN reward_config.rule_categories c ON c.id = sc.category_id
        WHERE c.category_code = 'TRANSACTION' AND sc.sub_category_code = 'GENERAL'`,
      { type: QueryTypes.SELECT },
    );
    expect(generalSubCategory).toHaveLength(1);
  });

  it('TC-3/R7: T105_002 down() -> up() round trip removes and exactly restores its own rows, in isolation', async () => {
    const snapshot = async (): Promise<{
      admins: number;
      apiKeys: number;
      transactionCategories: number;
      generalSubCategories: number;
      ruleMasters: number;
      ruleVersions: number;
    }> => {
      const count = async (sql: string): Promise<number> => {
        const [row] = (await sequelize.query(sql, {
          type: QueryTypes.SELECT,
        })) as unknown as [{ count: number }];
        return row.count;
      };
      return {
        admins: await count(
          `SELECT count(*)::int AS count FROM reward_config.admin_users WHERE email = 'bootstrap-admin@t163.invalid'`,
        ),
        apiKeys: await count(
          `SELECT count(*)::int AS count FROM reward_config.tenant_api_keys WHERE key_prefix = 'T163BOOT'`,
        ),
        transactionCategories: await count(
          `SELECT count(*)::int AS count FROM reward_config.rule_categories WHERE category_code = 'TRANSACTION'`,
        ),
        generalSubCategories: await count(
          `SELECT count(*)::int AS count FROM reward_config.rule_sub_categories sc
             JOIN reward_config.rule_categories c ON c.id = sc.category_id
            WHERE c.category_code = 'TRANSACTION' AND sc.sub_category_code = 'GENERAL'`,
        ),
        ruleMasters: await count(
          `SELECT count(*)::int AS count FROM reward_config.rule_master WHERE rule_code = ANY('{${SEED_RULE_CODES.join(',')}}')`,
        ),
        ruleVersions: await count(
          `SELECT count(*)::int AS count FROM reward_config.rule_versions rv
             JOIN reward_config.rule_master rm ON rm.id = rv.rule_id
            WHERE rm.rule_code = ANY('{${SEED_RULE_CODES.join(',')}}')`,
        ),
      };
    };

    const before = await snapshot();
    expect(before).toEqual({
      admins: 1,
      apiKeys: 1,
      transactionCategories: 1,
      generalSubCategories: 1,
      ruleMasters: SEED_RULE_CODES.length,
      ruleVersions: SEED_RULE_CODES.length,
    });

    await down({ context: sequelize });
    const afterDown = await snapshot();
    expect(afterDown).toEqual({
      admins: 0,
      apiKeys: 0,
      transactionCategories: 0,
      generalSubCategories: 0,
      ruleMasters: 0,
      ruleVersions: 0,
    });

    await up({ context: sequelize });
    const afterSecondUp = await snapshot();
    expect(afterSecondUp).toEqual(before);
  });

  it('idempotency: a second up() with everything already present inserts zero new rows', async () => {
    const countAdmins = async (): Promise<number> => {
      const [row] = (await sequelize.query(
        `SELECT count(*)::int AS count FROM reward_config.admin_users`,
        { type: QueryTypes.SELECT },
      )) as unknown as [{ count: number }];
      return row.count;
    };
    const before = await countAdmins();
    await up({ context: sequelize });
    const after = await countAdmins();
    expect(after).toBe(before);
  });
});

describe('T-163 — adjacent behaviour: T105_002 on the shared dev database (already-seeded, real admin_users/TRANSACTION/GENERAL)', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize?.close();
  });

  it('TC-4: up() against an already-real environment inserts no bootstrap admin/category rows and touches no counts', async () => {
    const snapshot = async (): Promise<{
      admins: number;
      apiKeys: number;
      transactionCategories: number;
      ruleMasters: number;
      ruleVersions: number;
    }> => {
      const count = async (sql: string): Promise<number> => {
        const [row] = (await sequelize.query(sql, {
          type: QueryTypes.SELECT,
        })) as unknown as [{ count: number }];
        return row.count;
      };
      return {
        admins: await count(`SELECT count(*)::int AS count FROM reward_config.admin_users`),
        apiKeys: await count(`SELECT count(*)::int AS count FROM reward_config.tenant_api_keys`),
        transactionCategories: await count(
          `SELECT count(*)::int AS count FROM reward_config.rule_categories WHERE category_code = 'TRANSACTION'`,
        ),
        ruleMasters: await count(`SELECT count(*)::int AS count FROM reward_config.rule_master`),
        ruleVersions: await count(`SELECT count(*)::int AS count FROM reward_config.rule_versions`),
      };
    };

    // Real environment invariant this test itself depends on: T105_002 has already been applied
    // here (it is a tracked, already-`done` migration on this shared database), so a real
    // admin_users row and a real TRANSACTION category already exist — the exact precondition
    // that must make every one of this fix's new bootstrap branches a no-op.
    const [{ count: existingAdmins }] = (await sequelize.query(
      `SELECT count(*)::int AS count FROM reward_config.admin_users`,
      { type: QueryTypes.SELECT },
    )) as unknown as [{ count: number }];
    expect(existingAdmins).toBeGreaterThan(0);
    const [{ count: existingTransaction }] = (await sequelize.query(
      `SELECT count(*)::int AS count FROM reward_config.rule_categories WHERE category_code = 'TRANSACTION'`,
      { type: QueryTypes.SELECT },
    )) as unknown as [{ count: number }];
    expect(existingTransaction).toBeGreaterThan(0);

    const before = await snapshot();
    await up({ context: sequelize });
    const after = await snapshot();
    expect(after).toEqual(before);
  });
});
