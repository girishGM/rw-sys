/**
 * T-050 retry 1/3 — fallback ephemeral-database provisioning against the real, already-running
 * local Postgres server this repo's own `CLAUDE.md` documents ("A real, pre-existing Postgres 16
 * server is already running on this machine ... use this one, don't install another"), used only
 * when no container runtime is reachable at all.
 *
 * Why this exists: the first review round found that `npm run e2e` cannot get past
 * `global-setup.ts`'s very first line in a Docker-less sandbox — `GenericContainer(...).start()`
 * throws `Could not find a working container runtime strategy` before a single spec runs, so the
 * suite produces zero evidence either way (not a failure of the suite's own logic, just nothing
 * to observe). Implementation note 1 ("Real Postgres via Testcontainers, migrated and seeded per
 * run") remains the primary, spec-mandated strategy, and is exactly what CI
 * (`.github/workflows/e2e.yml`, a Docker-equipped GitHub Actions runner) always uses — this file is
 * a disclosed, secondary path `global-setup.ts`'s `provisionDatabase` falls back to only when
 * Testcontainers itself reports no runtime is available, so the suite can still produce real,
 * observable pass/fail evidence on a workstation that has no Docker but does have the local
 * Postgres every dev machine for this project already runs (see `CLAUDE.md`'s "Local environment"
 * section).
 *
 * This never touches the real `reward_system`/`reward_config` database that same local server also
 * hosts for portal development — it creates a brand-new, uniquely-named, throwaway database on the
 * same server and drops it again in `global-teardown.ts`, exactly as disposable as a Testcontainers
 * instance, just not containerised.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import type { DbConnectionInfo } from './db';

const MAINTENANCE_DATABASE = 'postgres';

/** The exact lookup `CLAUDE.md` documents for any agent working in this repo — the
 * migration/superuser credential, read from this machine's own Keychain, never guessed or
 * hardcoded (R4: no secret in any committed file). Overridable via
 * `E2E_LOCAL_DB_SUPERUSER_PASSWORD` for a machine with no Keychain (a future Linux workstation, or
 * a Docker-less CI runner that still has a local Postgres) — this repo's own CI never takes this
 * path at all (it has Docker), so in practice this only ever runs on someone's own workstation. */
function resolveLocalSuperuserPassword(): string {
  const fromEnv = process.env.E2E_LOCAL_DB_SUPERUSER_PASSWORD;
  if (fromEnv) return fromEnv;
  if (process.platform === 'darwin') {
    try {
      return execFileSync(
        'security',
        ['find-generic-password', '-a', 'pgAdmin4-PostgreSQL 16-1', '-s', 'pgAdmin4', '-w'],
        { encoding: 'utf8' },
      ).trim();
    } catch (error) {
      throw new Error(
        'No container runtime is available, and the local Postgres superuser password could not ' +
          "be read from this Mac's Keychain (CLAUDE.md's documented lookup). Set " +
          'E2E_LOCAL_DB_SUPERUSER_PASSWORD explicitly, or make a container runtime (Docker/Podman) ' +
          `available instead. Underlying error: ${String(error)}`,
      );
    }
  }
  throw new Error(
    'No container runtime is available, and this is not macOS, so the Keychain lookup CLAUDE.md ' +
      'documents does not apply here. Set E2E_LOCAL_DB_SUPERUSER_PASSWORD explicitly, or make a ' +
      'container runtime (Docker/Podman) available instead.',
  );
}

/** Connection info for the maintenance database on the local server — used only to
 * `CREATE`/`DROP` this run's own ephemeral database, never to read or write `reward_system`
 * directly. */
export function localSuperuserConnection(): DbConnectionInfo {
  return {
    host: process.env.E2E_LOCAL_DB_HOST ?? 'localhost',
    port: Number(process.env.E2E_LOCAL_DB_PORT ?? 5432),
    database: MAINTENANCE_DATABASE,
    username: process.env.E2E_LOCAL_DB_SUPERUSER ?? 'postgres',
    password: resolveLocalSuperuserPassword(),
  };
}

/**
 * Creates a brand-new, uniquely-named database on the server `superuser` points at and returns
 * connection info for it. Unique per invocation (`Date.now()` + 3 random bytes) so two runs of
 * this suite launched one after another — including the DoD's own "run the full suite three times
 * in a row" — never collide, the same isolation a fresh Testcontainers instance gives for free.
 */
export async function createEphemeralDatabase(superuser: DbConnectionInfo): Promise<DbConnectionInfo> {
  const name = `e2e_${String(Date.now())}_${randomBytes(3).toString('hex')}`;
  const client = new Client({
    host: superuser.host,
    port: superuser.port,
    database: superuser.database,
    user: superuser.username,
    password: superuser.password,
  });
  await client.connect();
  try {
    // Identifier interpolation, not a bound query parameter — Postgres' own grammar does not
    // allow CREATE DATABASE to take one. `name` is generated on the line above from a clock
    // reading and random bytes, never from client/user input.
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
  return { ...superuser, database: name };
}

/**
 * Terminates any lingering connections (a crashed run can leave the back end's own pool still
 * attached) and drops the database `createEphemeralDatabase` made. Never touches anything else on
 * the server — in particular, never the real `reward_system`/`reward_config` that same server also
 * hosts for local portal development.
 */
export async function dropEphemeralDatabase(superuser: DbConnectionInfo, database: string): Promise<void> {
  const client = new Client({
    host: superuser.host,
    port: superuser.port,
    database: superuser.database,
    user: superuser.username,
    password: superuser.password,
  });
  await client.connect();
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database],
    );
    await client.query(`DROP DATABASE IF EXISTS "${database}"`);
  } finally {
    await client.end();
  }
}
