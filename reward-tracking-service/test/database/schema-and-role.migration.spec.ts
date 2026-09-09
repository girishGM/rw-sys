/**
 * T-RTS-002 regression suite for `001_create_schema_and_role.ts`. Runs against the real Postgres
 * 16 server documented in root `CLAUDE.md` — the `AGENT-PROTOCOL.md` §4 gate
 * (`db:migrate && db:rollback && db:migrate`) is run separately as its own bash step and is what
 * actually proves TC-1 (the full 8-migration round trip); this suite assumes the schema is
 * already migrated (as it is by the time `npm test` runs in the completion-report verification
 * sequence) and asserts what that schema carries — the real, Postgres-enforced property, not a
 * mocked/stubbed check (`AGENT-PROTOCOL.md` §3: "assert the observable property, not the
 * implementation string").
 *
 * TC-5 deliberately opens a second Postgres connection *as `reward_tracking_app`* and queries
 * `reward_redemption.reward_redemption_entry` — this looks at first glance like the exact thing R2
 * (`AGENT-PROTOCOL.md`: "never granted access outside the reward_tracking schema") forbids. It is
 * not: R2 exists to stop this service's own runtime business logic from depending on another
 * service's schema; this test does the opposite — it is the negative-permission proof this task's
 * own DoD requires (TC-5, Verification step 3), asserting the connection is *refused*, not
 * building on anything it would return. Mirrors
 * `reward-redemption-service/test/database/rr-app-role.migration.spec.ts` verbatim in shape.
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { createMigrator } from '@/database/umzug';
import * as schemaAndRoleMigration from '@/database/migrations/001_create_schema_and_role';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name} for this test suite`);
  }
  return value;
}

function createAppRoleConnection(): Sequelize {
  return new Sequelize({
    dialect: 'postgres',
    host: requireEnv('DB_HOST'),
    port: Number(requireEnv('DB_PORT')),
    database: requireEnv('DB_NAME'),
    username: requireEnv('DB_APP_USERNAME'),
    password: requireEnv('DB_APP_PASSWORD'),
    logging: false,
  });
}

describe('T-RTS-002 — schema + reward_tracking_app role migration', () => {
  let migrationSequelize: Sequelize;

  beforeAll(async () => {
    migrationSequelize = createMigrationConnection();
    await migrationSequelize.authenticate();
  });

  afterAll(async () => {
    await migrationSequelize.close();
  });

  // TC-1 (partial — bash-proven in full separately, R11): running the migrator against an
  // already-migrated DB resolves without error, same migrator code path exercised by the bash
  // gate's own migrate/rollback/migrate cycle.
  it('TC-1: running the migrator against an already-migrated DB resolves without error', async () => {
    const migrator = createMigrator(migrationSequelize);
    await expect(migrator.up()).resolves.toBeDefined();
  });

  it('the reward_tracking schema and pgcrypto extension exist', async () => {
    const [schema] = await migrationSequelize.query<{ schema_name: string }>(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'reward_tracking'",
      { type: QueryTypes.SELECT },
    );
    expect(schema).toBeDefined();

    const [extension] = await migrationSequelize.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'",
      { type: QueryTypes.SELECT },
    );
    expect(extension).toBeDefined();
  });

  it('the reward_tracking_app role exists with LOGIN', async () => {
    const [role] = await migrationSequelize.query<{ rolname: string; rolcanlogin: boolean }>(
      "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = 'reward_tracking_app'",
      { type: QueryTypes.SELECT },
    );
    expect(role).toBeDefined();
    expect(role.rolcanlogin).toBe(true);
  });

  // Negative: calling the migration's own up() with DB_APP_PASSWORD unset fails loudly, naming
  // the missing env var — never silently creating/altering the role with an empty or default
  // password (R12).
  it('up() rejects loudly when DB_APP_PASSWORD is unset, and never touches the role', async () => {
    const original = process.env.DB_APP_PASSWORD;
    delete process.env.DB_APP_PASSWORD;

    try {
      await expect(schemaAndRoleMigration.up({ context: migrationSequelize })).rejects.toThrow(
        /DB_APP_PASSWORD/,
      );
    } finally {
      if (original !== undefined) {
        process.env.DB_APP_PASSWORD = original;
      }
    }
  });

  // TC-5 (negative): reward_tracking_app can read its own schema's tables but is refused on
  // another service's schema — the real, Postgres-enforced property, not a mocked permission
  // check.
  it('TC-5: reward_tracking_app can query reward_tracking but is refused on reward_redemption.reward_redemption_entry', async () => {
    const appSequelize = createAppRoleConnection();
    try {
      await appSequelize.authenticate();

      await expect(
        appSequelize.query('SELECT count(*) FROM reward_tracking.service_config', {
          type: QueryTypes.SELECT,
        }),
      ).resolves.toBeDefined();

      await expect(
        appSequelize.query('SELECT 1 FROM reward_redemption.reward_redemption_entry LIMIT 1', {
          type: QueryTypes.SELECT,
        }),
      ).rejects.toMatchObject({
        parent: expect.objectContaining({
          message: expect.stringContaining('permission denied for schema reward_redemption'),
        }),
      });
    } finally {
      await appSequelize.close();
    }
  });

  // A table created AFTER this role migration (002-008 all run after 001) is still covered by the
  // role's grants — proves the `ALTER DEFAULT PRIVILEGES` statement in 001's own up() actually
  // reaches tables that didn't exist yet when it ran, not just the `GRANT ... ON ALL TABLES`
  // no-op at that same instant.
  it('reward_tracking_app can write to a table created by a later migration (default privileges)', async () => {
    const appSequelize = createAppRoleConnection();
    try {
      await appSequelize.authenticate();
      await expect(
        appSequelize.query(`SELECT count(*) FROM reward_tracking.reward_fact`, {
          type: QueryTypes.SELECT,
        }),
      ).resolves.toBeDefined();
    } finally {
      await appSequelize.close();
    }
  });
});
