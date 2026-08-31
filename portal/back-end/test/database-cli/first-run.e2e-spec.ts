/**
 * T-057 retry 1 (2026-08-20) — proves the "provision keys via the CLI, then
 * `bootstrap:superadmin`" half of `DEPLOYMENT.md`'s first-run sequence (D-2/D-3, TC-9/TC-11,
 * verification step 3) end-to-end, against a database this suite creates and drops itself.
 *
 * ### Why this exists, and why now
 *
 * The original T-057 report performed this verification once, by hand, against the shared
 * local `reward_system` database every other task's e2e suite (and this machine's own manual
 * sessions) also depends on. That is exactly what turned into a real regression: the two rows
 * it left behind (`dev_local_fld`/`dev_local_bidx`, both `active`) are now permanently
 * load-bearing for real `portal_users` rows on this machine — see `crypto.e2e-spec.ts`'s
 * header for the fix that lets T-016's own suite coexist with that. Running the same manual
 * sequence a second time against the same shared database would either collide with that live
 * state again or require deleting data this task does not own — neither is acceptable. This
 * suite proves the sequence instead against a disposable database it fully owns: cheap enough
 * (tens of seconds) to run on every future review pass, not just once by hand, and immune to
 * whatever state the shared database happens to be in.
 *
 * ### What "clean" means here
 *
 * A brand-new, uniquely-named Postgres database on the same local server `CLAUDE.md`
 * documents (never a second server — that file is explicit about using the one already
 * running) — no `reward_portal` schema, no `reward_config` schema, no rows, until this suite
 * creates them via the real `npm run db:migrate` and the real
 * `database/reward_config/reward_config_postgres.sql` (one level above `portal/` — read-only
 * input here, the same relationship `e2e/utils/db.ts#loadRewardConfigSchema` has to it for
 * T-050's own suite, though that file's own path constant has the same pre-restructuring
 * staleness this task fixes here — see T-152's completion report). The superuser-credential
 * lookup and ephemeral-database lifecycle below are the same
 * strategy `e2e/utils/localPostgres.ts` already established for a Docker-less sandbox —
 * duplicated narrowly here rather than imported, because `e2e/` is a separate npm workspace
 * with its own `tsconfig`/module resolution, not reachable from `back-end`'s.
 *
 * `db:migrate` itself is not re-proven from an empty database here — T-002/T-005/etc.'s own
 * suites already do that on every run via this same live server. What this file adds is the
 * part nothing else in this codebase automated: D-2 (`encryption-keys.ts provision`) and D-3
 * (key material resolved from a `.env`-style source) actually letting
 * `bootstrap:superadmin` succeed, in combination, exactly as `DEPLOYMENT.md` describes.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

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

const SUPERADMIN_EMAIL = 't057.firstrun@e2e.invalid';
const SUPERADMIN_NAME = 'T-057 First-Run Verification';
const SUPERADMIN_PASSWORD = 'Correct-Horse-Battery-Staple-9!';

/** Same lookup `CLAUDE.md` documents for any agent working in this repo, and the same one
 * `e2e/utils/localPostgres.ts` uses — the migration/superuser credential, read from this
 * machine's own Keychain, never guessed or hardcoded (R4). */
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

/** Runs a back-end CLI script as a real child process — the same `spawnSync('npx', ['ts-node',
 * ...])` shape `encryption-keys.e2e-spec.ts` already uses for the CLI itself, applied here to
 * `migrate.ts` and `bootstrap-superadmin.ts` too so this whole sequence runs exactly the way
 * an operator following `DEPLOYMENT.md` would, not through any in-process shortcut. */
function runScript(
  scriptRelativePath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    'npx',
    ['ts-node', '-T', '-r', 'tsconfig-paths/register', scriptRelativePath, ...args],
    { cwd: BACK_END_DIR, env, encoding: 'utf8', timeout: 60_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('T-057 first-run sequence — migrate (already applied) + provision + bootstrap, on a fresh scratch database', () => {
  let superuserPassword: string;
  let scratchDb: string;
  let baseEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    superuserPassword = resolveSuperuserPassword();
    scratchDb = `t057_scratch_${String(Date.now())}_${randomBytes(3).toString('hex')}`;

    await withMaintenanceClient(superuserPassword, async (client) => {
      await client.query(`CREATE DATABASE "${scratchDb}"`);
    });

    const reward_config_sql = readFileSync(REWARD_CONFIG_SQL_PATH, 'utf8');
    const scratchClient = new Client({
      host: DB_HOST,
      port: DB_PORT,
      database: scratchDb,
      user: 'postgres',
      password: superuserPassword,
    });
    await scratchClient.connect();
    try {
      await scratchClient.query(reward_config_sql);
    } finally {
      await scratchClient.end();
    }

    // Collapse the migration/app-role split to one superuser for this disposable database —
    // the same, disclosed simplification `e2e/global-setup.ts` makes for the same reason:
    // this suite is not what re-proves that split holds (`test/database`'s own suite is).
    baseEnv = {
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
  }, 60_000);

  afterAll(async () => {
    if (scratchDb === undefined) return;
    await withMaintenanceClient(superuserPassword, async (client) => {
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [scratchDb],
      );
      await client.query(`DROP DATABASE IF EXISTS "${scratchDb}"`);
    });
  }, 30_000);

  it('migrate -> provision field+blind_index via the CLI -> bootstrap:superadmin, all succeed in order', () => {
    // Step 2 (DEPLOYMENT.md): migrate.
    const migrate = runScript('src/database/cli/migrate.ts', ['up'], baseEnv);
    expect(migrate.status).toBe(0);

    // Step 3: provision the first active field + blind_index key via the CLI this task adds.
    const provisionField = runScript(
      'src/database/cli/encryption-keys.ts',
      ['provision', 'field'],
      baseEnv,
    );
    expect(provisionField.status).toBe(0);
    const fieldMatch = /^\s{4}(\S+)=(\S+)$/m.exec(provisionField.stdout);
    expect(fieldMatch).not.toBeNull();
    const [, fieldEnvVar, fieldMaterial] = fieldMatch as RegExpExecArray;

    const provisionBidx = runScript(
      'src/database/cli/encryption-keys.ts',
      ['provision', 'blind_index'],
      baseEnv,
    );
    expect(provisionBidx.status).toBe(0);
    const bidxMatch = /^\s{4}(\S+)=(\S+)$/m.exec(provisionBidx.stdout);
    expect(bidxMatch).not.toBeNull();
    const [, bidxEnvVar, bidxMaterial] = bidxMatch as RegExpExecArray;

    // Step 4: bootstrap:superadmin — requires step 3's key material to be reachable in the
    // real process environment, exactly as DEPLOYMENT.md's own "note on where key material
    // may live" (D-3) describes.
    const bootstrap = runScript('src/cli/bootstrap-superadmin.ts', [], {
      ...baseEnv,
      [fieldEnvVar]: fieldMaterial,
      [bidxEnvVar]: bidxMaterial,
      SUPERADMIN_EMAIL: SUPERADMIN_EMAIL,
      SUPERADMIN_NAME: SUPERADMIN_NAME,
      SUPERADMIN_PASSWORD: SUPERADMIN_PASSWORD,
    });
    expect(bootstrap.status).toBe(0);
    expect(bootstrap.stdout + bootstrap.stderr).not.toMatch(/KeyRegistryError/);
  }, 120_000);

  it('the scratch database now holds exactly the state DEPLOYMENT.md promises', async () => {
    const client = new Client({
      host: DB_HOST,
      port: DB_PORT,
      database: scratchDb,
      user: 'postgres',
      password: superuserPassword,
    });
    await client.connect();
    try {
      const keys = await client.query<{ purpose: string; status: string; algorithm: string }>(
        `SELECT purpose, status, algorithm FROM reward_portal.encryption_keys ORDER BY purpose`,
      );
      expect(keys.rows).toEqual([
        { purpose: 'blind_index', status: 'active', algorithm: 'HMAC-SHA256' },
        { purpose: 'field', status: 'active', algorithm: 'AES-256-GCM' },
      ]);

      const users = await client.query<{ role: string; must_change_password: boolean }>(
        `SELECT role, must_change_password FROM reward_portal.portal_users`,
      );
      expect(users.rows).toEqual([{ role: 'super_admin', must_change_password: true }]);
    } finally {
      await client.end();
    }
  });
});
