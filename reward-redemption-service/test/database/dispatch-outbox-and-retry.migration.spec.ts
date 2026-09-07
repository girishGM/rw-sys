/**
 * T-RR-003 regression suite for `reward_tracking_dispatch_outbox` / `reward_tracking_dispatch_retry`
 * (`01-DATABASE.md` §7), plus `notification_log` (§8) and `external_system_call_log` (§9), which
 * share the identical "real FK to `reward_redemption_entry`" shape and FK-ordering concern
 * (T-RR-003 note 4). See `reward-redemption-failed.migration.spec.ts`'s header (T-RR-002) for
 * this suite's own conventions (real Postgres, a real `reward_redemption_entry` fixture row).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';

const TENANT_ID = 900_000 + Math.floor(Math.random() * 99_999);

async function insertEntry(sequelize: Sequelize, id: string): Promise<void> {
  await sequelize.query(
    `INSERT INTO reward_redemption.reward_redemption_entry
       (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash, customer_id_type,
        activity_performed_date, activity_type, activity_category, activity_value,
        activity_value_unit, channel, activity_performed_env, activity_name, campaign_code,
        tracker_code, tracker_component_code, reward_code, reward_category, reward_value,
        reward_value_unit, reward_entry_date, reward_processed_env, ingestion_channel, status)
     VALUES
       (:id, :correlation_id, :tenant_id, 'ciphertext-placeholder', :customer_id_hash, 'EMAIL',
        now(), 'PURCHASE', 'SPEND', 10, 'USD', 'WEB', 'PROD', 't-rr-003 outbox/retry fixture',
        'CAMP1', 'TRK1', 'COMP1', 'RWD1', 'CASHBACK', 5, 'USD', now(), 'development', 'REST',
        'received')`,
    {
      type: QueryTypes.RAW,
      replacements: {
        id,
        correlation_id: randomUUID(),
        tenant_id: TENANT_ID,
        customer_id_hash: `hash-${randomUUID()}`,
      },
    },
  );
}

describe('T-RR-003 — reward_tracking_dispatch_outbox / _retry / notification_log / external_system_call_log migrations', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.query(
      'DELETE FROM reward_redemption.reward_tracking_dispatch_outbox WHERE reward_entry_id IN (SELECT id FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id)',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.query(
      'DELETE FROM reward_redemption.reward_tracking_dispatch_retry WHERE reward_entry_id IN (SELECT id FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id)',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.query(
      'DELETE FROM reward_redemption.notification_log WHERE reward_entry_id IN (SELECT id FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id)',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.query(
      'DELETE FROM reward_redemption.external_system_call_log WHERE reward_entry_id IN (SELECT id FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id)',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.close();
  });

  // TC-5: an outbox row referencing a real reward_redemption_entry.id succeeds.
  it('TC-5: an outbox row referencing a real reward_redemption_entry succeeds', async () => {
    const entryId = randomUUID();
    await insertEntry(sequelize, entryId);

    const [row] = await sequelize.query<{ id: string }>(
      `INSERT INTO reward_redemption.reward_tracking_dispatch_outbox (reward_entry_id, payload)
       VALUES (:reward_entry_id, :payload)
       RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: { reward_entry_id: entryId, payload: JSON.stringify({ ok: true }) },
      },
    );
    expect(row.id).toBeDefined();
  });

  // TC-6 (negative): an outbox row referencing a non-existent reward_entry_id raises a real
  // 23503 foreign-key violation.
  it('TC-6: an outbox row referencing a non-existent reward_entry_id raises a 23503 FK violation', async () => {
    await expect(
      sequelize.query(
        `INSERT INTO reward_redemption.reward_tracking_dispatch_outbox (reward_entry_id, payload)
         VALUES (:reward_entry_id, :payload)`,
        {
          type: QueryTypes.RAW,
          replacements: { reward_entry_id: randomUUID(), payload: JSON.stringify({ ok: true }) },
        },
      ),
    ).rejects.toMatchObject({
      name: 'SequelizeForeignKeyConstraintError',
      parent: expect.objectContaining({ code: '23503' }),
    });
  });

  // Same FK behavior on the tier-3 retry table, notification_log and external_system_call_log —
  // all four share the identical "real FK to reward_redemption_entry" shape (T-RR-003 note 4).
  it('a retry row referencing a real entry succeeds; a non-existent reward_entry_id is rejected (23503)', async () => {
    const entryId = randomUUID();
    await insertEntry(sequelize, entryId);

    await expect(
      sequelize.query(
        `INSERT INTO reward_redemption.reward_tracking_dispatch_retry (reward_entry_id, payload)
         VALUES (:reward_entry_id, :payload)`,
        {
          type: QueryTypes.RAW,
          replacements: { reward_entry_id: entryId, payload: JSON.stringify({ ok: true }) },
        },
      ),
    ).resolves.toBeDefined();

    await expect(
      sequelize.query(
        `INSERT INTO reward_redemption.reward_tracking_dispatch_retry (reward_entry_id, payload)
         VALUES (:reward_entry_id, :payload)`,
        {
          type: QueryTypes.RAW,
          replacements: { reward_entry_id: randomUUID(), payload: JSON.stringify({ ok: true }) },
        },
      ),
    ).rejects.toMatchObject({
      name: 'SequelizeForeignKeyConstraintError',
      parent: expect.objectContaining({ code: '23503' }),
    });
  });

  it('a notification_log row referencing a real entry succeeds; a non-existent reward_entry_id is rejected (23503)', async () => {
    const entryId = randomUUID();
    await insertEntry(sequelize, entryId);

    await expect(
      sequelize.query(
        `INSERT INTO reward_redemption.notification_log
           (reward_entry_id, tenant_id, customer_id_hash, campaign_code, reward_code, channel, would_be_payload)
         VALUES (:reward_entry_id, :tenant_id, :hash, 'CAMP1', 'RWD1', 'PUSH', :payload)`,
        {
          type: QueryTypes.RAW,
          replacements: {
            reward_entry_id: entryId,
            tenant_id: TENANT_ID,
            hash: `hash-${randomUUID()}`,
            payload: JSON.stringify({ title: 'ok' }),
          },
        },
      ),
    ).resolves.toBeDefined();

    await expect(
      sequelize.query(
        `INSERT INTO reward_redemption.notification_log
           (reward_entry_id, tenant_id, customer_id_hash, campaign_code, reward_code, channel, would_be_payload)
         VALUES (:reward_entry_id, :tenant_id, :hash, 'CAMP1', 'RWD1', 'PUSH', :payload)`,
        {
          type: QueryTypes.RAW,
          replacements: {
            reward_entry_id: randomUUID(),
            tenant_id: TENANT_ID,
            hash: `hash-${randomUUID()}`,
            payload: JSON.stringify({ title: 'ok' }),
          },
        },
      ),
    ).rejects.toMatchObject({
      name: 'SequelizeForeignKeyConstraintError',
      parent: expect.objectContaining({ code: '23503' }),
    });
  });

  it('an external_system_call_log row referencing a real entry succeeds; a non-existent reward_entry_id is rejected (23503)', async () => {
    const entryId = randomUUID();
    await insertEntry(sequelize, entryId);

    await expect(
      sequelize.query(
        `INSERT INTO reward_redemption.external_system_call_log
           (reward_entry_id, system_code, attempt_number, request_summary, result, latency_ms)
         VALUES (:reward_entry_id, 'PROMO_CODE_SERVICE', 1, :request_summary, 'SUCCESS', 120)`,
        {
          type: QueryTypes.RAW,
          replacements: { reward_entry_id: entryId, request_summary: JSON.stringify({}) },
        },
      ),
    ).resolves.toBeDefined();

    await expect(
      sequelize.query(
        `INSERT INTO reward_redemption.external_system_call_log
           (reward_entry_id, system_code, attempt_number, request_summary, result, latency_ms)
         VALUES (:reward_entry_id, 'PROMO_CODE_SERVICE', 1, :request_summary, 'SUCCESS', 120)`,
        {
          type: QueryTypes.RAW,
          replacements: { reward_entry_id: randomUUID(), request_summary: JSON.stringify({}) },
        },
      ),
    ).rejects.toMatchObject({
      name: 'SequelizeForeignKeyConstraintError',
      parent: expect.objectContaining({ code: '23503' }),
    });
  });
});
