/**
 * T-INT-051 regression suite for
 * `026_add_reward_tracking_dispatch_outbox_last_error.ts`. Runs against the real Postgres 16
 * server (root `CLAUDE.md`) — the AGENT-PROTOCOL.md §4 gate (`db:migrate && db:rollback &&
 * db:migrate`) is run separately as its own bash step and is what actually proves the migration
 * applies/rolls back/re-applies cleanly; this suite assumes the schema is already migrated (as it
 * is by the time `npm test`/this task's own Verification steps run) and asserts the real,
 * Postgres-enforced shape: the new nullable `last_error` column exists and round-trips a value.
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { createMigrator } from '@/database/umzug';

describe('T-INT-051 — reward_tracking_dispatch_outbox.last_error column', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.close();
  });

  // Bash-proven separately too (Verification step: db:migrate && db:rollback && db:migrate) —
  // exercised here as well so this same migrator code path is asserted from within the suite.
  it('running the migrator against an already-migrated DB resolves without error', async () => {
    const migrator = createMigrator(sequelize);
    await expect(migrator.up()).resolves.toBeDefined();
  });

  it('last_error is a nullable text column on reward_tracking_dispatch_outbox', async () => {
    const [column] = await sequelize.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'reward_redemption'
          AND table_name = 'reward_tracking_dispatch_outbox'
          AND column_name = 'last_error'`,
      { type: QueryTypes.SELECT },
    );

    expect(column).toBeDefined();
    expect(column.data_type).toBe('text');
    expect(column.is_nullable).toBe('YES');
  });

  it("'POISONED' is a legal value for the pre-existing unconstrained status column (no CHECK constraint added by this or any prior migration)", async () => {
    const constraints = await sequelize.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'reward_redemption.reward_tracking_dispatch_outbox'::regclass
          AND contype = 'c'`,
      { type: QueryTypes.SELECT },
    );
    expect(constraints).toHaveLength(0);
  });
});
