/**
 * T-RTS-002 regression suite for `002_create_inbound_event_log.ts`
 * (`brain-storm/02-DATA-MODEL.md` §1.1). See `schema-and-role.migration.spec.ts`'s header for this
 * suite's own conventions (assumes an already-migrated DB).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';

describe('T-RTS-002 — inbound_event_log migration', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.close();
  });

  it('the table and its unique constraint exist with the expected shape', async () => {
    const columns = await sequelize.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'reward_tracking' AND table_name = 'inbound_event_log'`,
      { type: QueryTypes.SELECT },
    );
    expect(columns.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        'id',
        'reward_entry_id',
        'received_channel',
        'payload',
        'received_at',
        'processed_at',
        'processing_status',
        'error_message',
      ]),
    );

    const constraints = await sequelize.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
         WHERE conrelid = 'reward_tracking.inbound_event_log'::regclass AND contype = 'u'`,
      { type: QueryTypes.SELECT },
    );
    expect(constraints.map((c) => c.conname)).toContain('uq_iel_reward_entry');
  });

  // TC-2: a second insert with the SAME reward_entry_id, over a DIFFERENT received_channel, still
  // collapses into the same fact — the dedupe key is the business id, never the transport (R3).
  // uq_iel_reward_entry is UNIQUE on reward_entry_id ALONE, so a redelivery over a different
  // channel raises the identical 23505 violation as a same-channel redelivery would.
  it('TC-2: a second insert with the same reward_entry_id but a different source channel violates uq_iel_reward_entry', async () => {
    const rewardEntryId = `RE-${randomUUID()}`;
    const insert = (channel: string) =>
      sequelize.query(
        `INSERT INTO reward_tracking.inbound_event_log (reward_entry_id, received_channel, payload)
         VALUES (:rewardEntryId, :channel, :payload)`,
        {
          type: QueryTypes.RAW,
          replacements: { rewardEntryId, channel, payload: JSON.stringify({ ok: true }) },
        },
      );

    await expect(insert('KAFKA')).resolves.toBeDefined();
    await expect(insert('REST')).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ code: '23505' }),
    });
  });

  afterEach(async () => {
    await sequelize.query(
      "DELETE FROM reward_tracking.inbound_event_log WHERE reward_entry_id LIKE 'RE-%'",
      { type: QueryTypes.RAW },
    );
  });
});
