/**
 * T-RTS-002 regression suite for `004_create_customer_reward_ledger.ts`
 * (`brain-storm/02-DATA-MODEL.md` §3.1). See `schema-and-role.migration.spec.ts`'s header for
 * this suite's own conventions.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';

describe('T-RTS-002 — customer_reward_ledger migration', () => {
  let sequelize: Sequelize;
  const customerIdHash = `hash-${randomUUID()}`;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.query(
      'DELETE FROM reward_tracking.customer_reward_ledger WHERE customer_id_hash = :hash',
      { type: QueryTypes.RAW, replacements: { hash: customerIdHash } },
    );
    await sequelize.close();
  });

  const insertLedgerRow = (rewardKind: string | null) =>
    sequelize.query(
      `INSERT INTO reward_tracking.customer_reward_ledger
         (tenant_id, customer_id_hash, campaign_code, tracker_code, tracker_component_code,
          reward_category, reward_kind, total_reward_value, total_reward_count, first_earned_at,
          last_earned_at)
       VALUES
         (900001, :hash, 'CAMP1', 'TRK1', 'COMP1', 'CASHBACK', :rewardKind, 5, 1, now(), now())`,
      { type: QueryTypes.RAW, replacements: { hash: customerIdHash, rewardKind } },
    );

  // uq_crl also includes unit_type/unit_code — both nullable, and standard SQL/Postgres unique-
  // constraint semantics never consider two NULLs equal (the same quirk
  // `service-config.migration.spec.ts` documents for `scope_ref`), so a real duplicate needs
  // concrete, matching values in every unique-key column, not just a matching reward_kind.
  const insertLedgerRowWithUnit = () =>
    sequelize.query(
      `INSERT INTO reward_tracking.customer_reward_ledger
         (tenant_id, customer_id_hash, campaign_code, tracker_code, tracker_component_code,
          reward_category, reward_kind, unit_type, unit_code, total_reward_value,
          total_reward_count, first_earned_at, last_earned_at)
       VALUES
         (900001, :hash, 'CAMP1', 'TRK1', 'COMP1', 'CASHBACK', 'POINTS', 'CURRENCY', 'USD', 5, 1,
          now(), now())`,
      { type: QueryTypes.RAW, replacements: { hash: customerIdHash } },
    );

  it('the table, its unique constraint and both indexes exist', async () => {
    const constraints = await sequelize.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
         WHERE conrelid = 'reward_tracking.customer_reward_ledger'::regclass AND contype = 'u'`,
      { type: QueryTypes.SELECT },
    );
    expect(constraints.map((c) => c.conname)).toContain('uq_crl');

    const indexes = await sequelize.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'reward_tracking' AND tablename = 'customer_reward_ledger'`,
      { type: QueryTypes.SELECT },
    );
    expect(indexes.map((i) => i.indexname)).toEqual(
      expect.arrayContaining(['ix_crl_customer', 'ix_crl_tracker']),
    );
  });

  // TC-3: a row differing ONLY in reward_kind is a genuinely separate row, not a constraint
  // violation — proves reward_kind is really part of uq_crl's own grain, not decoration (§2.2:
  // a FIXED_AMOUNT row and a PERCENTAGE row for the same tracker/component must never merge).
  it('TC-3: two rows identical except for reward_kind both succeed as independent rows', async () => {
    await expect(insertLedgerRow('FIXED_AMOUNT')).resolves.toBeDefined();
    await expect(insertLedgerRow('PERCENTAGE')).resolves.toBeDefined();

    const rows = await sequelize.query<{ reward_kind: string }>(
      `SELECT reward_kind FROM reward_tracking.customer_reward_ledger
         WHERE customer_id_hash = :hash AND campaign_code = 'CAMP1'`,
      { type: QueryTypes.SELECT, replacements: { hash: customerIdHash } },
    );
    expect(rows.map((r) => r.reward_kind).sort()).toEqual(['FIXED_AMOUNT', 'PERCENTAGE']);
  });

  it('a genuine duplicate (identical grain including unit_type/unit_code and reward_kind) violates uq_crl', async () => {
    await expect(insertLedgerRowWithUnit()).resolves.toBeDefined();
    await expect(insertLedgerRowWithUnit()).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ code: '23505' }),
    });
  });
});
