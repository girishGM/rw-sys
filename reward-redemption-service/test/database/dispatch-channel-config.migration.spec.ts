/**
 * T-RR-003 regression suite for `dispatch_channel_config` (`01-DATABASE.md` §5). See
 * `reward-redemption-entry.migration.spec.ts`'s header (T-RR-002) for this suite's own
 * conventions. `scope_ref_code` values here are randomized per run so parallel runs never
 * collide with each other or with the one real seeded `GLOBAL` row.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import type { DispatchChannelConfigRow } from '@/database/models/dispatch-channel-config.model';

describe('T-RR-003 — dispatch_channel_config migration', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.query(
      "DELETE FROM reward_redemption.dispatch_channel_config WHERE scope_ref_code LIKE 'TEST_%'",
      { type: QueryTypes.RAW },
    );
    await sequelize.close();
  });

  // TC-4: exactly one GLOBAL row exists immediately after migration, KAFKA primary / REST
  // fallback — the resolver's own last-resort fallback (T-RR-003 note 2).
  it('TC-4: exactly one GLOBAL row exists, primary_channel=KAFKA, fallback_channel=REST', async () => {
    const rows = await sequelize.query<DispatchChannelConfigRow>(
      "SELECT * FROM reward_redemption.dispatch_channel_config WHERE scope_level = 'GLOBAL'",
      { type: QueryTypes.SELECT },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].scope_ref_code).toBeNull();
    expect(rows[0].tenant_id).toBeNull();
    expect(rows[0].primary_channel).toBe('KAFKA');
    expect(rows[0].fallback_channel).toBe('REST');
  });

  // T-RR-003 note 1's own documented, deliberately-not-fixed behavior: standard SQL/Postgres
  // treats NULL as never equal to NULL for a composite unique index, so a *second* row whose
  // scope_ref_code or tenant_id is NULL never conflicts with the first — confirmed empirically
  // against real Postgres while building this suite (a second GLOBAL row, and a second
  // tenant_id=NULL REWARD row for the same scope_ref_code, both insert without error). This is
  // exactly the behavior note 1 says is "correct for its own semantics" and instructs not to
  // "fix" to match §3's generated-column trick — asserted here as a guard against a future change
  // silently adding that trick and breaking this documented tolerance.
  it('a second GLOBAL row (NULL scope_ref_code, NULL tenant_id) does not conflict with the seeded one', async () => {
    await expect(
      sequelize.query(
        `INSERT INTO reward_redemption.dispatch_channel_config (scope_level, scope_ref_code, tenant_id)
         VALUES ('GLOBAL', NULL, NULL)`,
        { type: QueryTypes.RAW },
      ),
    ).resolves.toBeDefined();

    // Clean up immediately so no other test (or a later manual query) observes more than the one
    // real seeded GLOBAL row — this test's own side effect, not TC-4's assertion above.
    await sequelize.query(
      `DELETE FROM reward_redemption.dispatch_channel_config
         WHERE scope_level = 'GLOBAL' AND ctid NOT IN (
           SELECT min(ctid) FROM reward_redemption.dispatch_channel_config WHERE scope_level = 'GLOBAL'
         )`,
      { type: QueryTypes.RAW },
    );
  });

  it('a REWARD-scope row with a real tenant_id inserts once; a duplicate (scope_level, scope_ref_code, tenant_id) triple is rejected', async () => {
    const rewardCode = `TEST_${randomUUID().slice(0, 8)}`;
    const insert = () =>
      sequelize.query(
        `INSERT INTO reward_redemption.dispatch_channel_config (scope_level, scope_ref_code, tenant_id)
         VALUES ('REWARD', :reward_code, 5)`,
        { type: QueryTypes.RAW, replacements: { reward_code: rewardCode } },
      );

    await expect(insert()).resolves.toBeDefined();
    await expect(insert()).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ code: '23505' }),
    });
  });
});
