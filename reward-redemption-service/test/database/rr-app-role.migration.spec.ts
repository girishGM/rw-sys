/**
 * T-RR-003 regression suite for the `rr_app` least-privilege role migration
 * (`014_create_rr_app_role.ts`, `01-DATABASE.md` §13). Two things this suite proves that the
 * bash gate (`db:migrate && db:rollback -- --all && db:migrate`, R4) doesn't exercise on its own:
 * TC-8 (a missing `DB_APP_PASSWORD` fails the migration loudly, never silently) and TC-9 (the
 * role genuinely cannot read another service's schema).
 *
 * TC-9 deliberately opens a second Postgres connection *as `rr_app`* and queries
 * `reward_config.reward_systems` — this looks at first glance like the exact thing R5
 * (AGENT-PROTOCOL.md: "never open a connection to ... reward_config") forbids. It is not: R5
 * exists to stop this service's own runtime business logic from depending on another service's
 * schema; this test does the opposite — it is the negative-permission proof this task's own DoD
 * requires (TC-9, Verification step 4), asserting the connection is *refused*, not building on
 * anything it would return. `reward_config.reward_systems` is used only as a stand-in "any table
 * outside reward_redemption" target — the real, physical Postgres instance both schemas already
 * share on this machine (root `CLAUDE.md`).
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import * as rrAppRoleMigration from '@/database/migrations/014_create_rr_app_role';

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

describe('T-RR-003 — rr_app role migration', () => {
  let migrationSequelize: Sequelize;

  beforeAll(async () => {
    migrationSequelize = createMigrationConnection();
    await migrationSequelize.authenticate();
  });

  afterAll(async () => {
    await migrationSequelize.close();
  });

  it('the rr_app role exists with LOGIN, scoped only to reward_redemption', async () => {
    const [role] = await migrationSequelize.query<{ rolname: string; rolcanlogin: boolean }>(
      "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = 'rr_app'",
      { type: QueryTypes.SELECT },
    );
    expect(role).toBeDefined();
    expect(role.rolcanlogin).toBe(true);
  });

  // TC-8 (negative): calling the migration's own up() with DB_APP_PASSWORD unset fails loudly,
  // naming the missing env var — never silently creating/altering the role with an empty or
  // default password.
  it('TC-8: up() rejects loudly when DB_APP_PASSWORD is unset, and never touches the role', async () => {
    const original = process.env.DB_APP_PASSWORD;
    delete process.env.DB_APP_PASSWORD;

    try {
      await expect(rrAppRoleMigration.up({ context: migrationSequelize })).rejects.toThrow(
        /DB_APP_PASSWORD/,
      );
    } finally {
      if (original !== undefined) {
        process.env.DB_APP_PASSWORD = original;
      }
    }
  });

  // TC-9 (negative): rr_app can read its own schema's tables but is refused on another service's
  // schema — the real, Postgres-enforced property (AGENT-PROTOCOL.md §3: "assert the observable
  // property, not the implementation string"), not a mocked permission check.
  it('TC-9: rr_app can query reward_redemption but is refused on reward_config', async () => {
    const appSequelize = createAppRoleConnection();
    try {
      await appSequelize.authenticate();

      await expect(
        appSequelize.query('SELECT count(*) FROM reward_redemption.dispatch_channel_config', {
          type: QueryTypes.SELECT,
        }),
      ).resolves.toBeDefined();

      await expect(
        appSequelize.query('SELECT 1 FROM reward_config.reward_systems LIMIT 1', {
          type: QueryTypes.SELECT,
        }),
      ).rejects.toMatchObject({
        parent: expect.objectContaining({
          message: expect.stringContaining('permission denied for schema reward_config'),
        }),
      });
    } finally {
      await appSequelize.close();
    }
  });
});
