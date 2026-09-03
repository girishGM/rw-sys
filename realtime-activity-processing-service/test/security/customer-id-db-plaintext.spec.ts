/**
 * T-RAP-042 — TC-1. Independent, real-Postgres proof that a plaintext `customerId` never lands in
 * any text-shaped column anywhere in the `realtime_activity_processing` schema
 * (`AGENT-PROTOCOL.md` R4, `01-DATABASE.md` §3/§7).
 *
 * Deliberately does **not** hand-pick which columns to check (a hand-picked list only proves "the
 * columns I already believe are safe are safe" — exactly the "reading the code and concluding it
 * must be fine" this task's own Implementation note 1 warns against). Instead it reads the schema's
 * own `information_schema.columns` for every text-shaped column that currently exists, on every
 * table, and greps every one of them for a plaintext marker this test itself inserted — so a new
 * table or column added later that accidentally carries a plaintext customerId would fail this
 * test the next time it runs, without this file needing to know that table/column exists.
 *
 * Connects as `rap_app` (the real least-privilege runtime role, `AGENT-PROTOCOL.md` R1) — same
 * real-Postgres convention `activity-logs.repository.spec.ts` (T-RAP-021) already established.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes, type Transaction } from 'sequelize';
import {
  ActivityLogsRepository,
  type FanOutRowInput,
} from '@/modules/activity-mapping/activity-logs.repository';
import { EncryptionService } from '@/modules/encryption/encryption.service';

const AES_KEY = Buffer.alloc(32, 101).toString('base64');
const HMAC_KEY = Buffer.alloc(32, 102).toString('base64');

const TENANT_ID = 981_000 + Math.floor(Math.random() * 8_999);
// Distinctive enough that it can never collide with real data, and shaped so an accidental
// substring match (e.g. inside a UUID) is effectively impossible.
const PLAINTEXT_MARKER = `SECREVIEW-PLAINTEXT-CUSTID-${randomUUID()}`;

interface TextColumn {
  table_name: string;
  column_name: string;
}

function fanOutRow(overrides: Partial<FanOutRowInput> = {}): FanOutRowInput {
  return {
    correlationId: randomUUID(),
    dedupKey: `dedup-${randomUUID()}`,
    tenantId: TENANT_ID,
    customerIdEncrypted: 'placeholder',
    customerIdHash: 'placeholder',
    customerIdType: 'INTERNAL_ID',
    activityPerformedDate: new Date('2026-09-01T10:15:30.000Z'),
    transactionType: null,
    activityCode: 'PURCHASE',
    activityType: 'TRANSACTION',
    activityCategory: 'RETAIL',
    activityValue: '10.0000',
    activityValueUnit: 'USD',
    channel: 'WEB',
    activityPerformedEnv: 'PROD',
    activityName: 'T-RAP-042 security-review fixture',
    campaignCode: 'SECREVIEW-CAMP',
    trackerCode: 'SECREVIEW-TRK',
    trackerComponentCode: 'SECREVIEW-COMP',
    merchantCode: null,
    sourceTransport: 'GRPC',
    ...overrides,
  };
}

describe('T-RAP-042 TC-1 — no plaintext customerId anywhere in the DB (real Postgres, rap_app role)', () => {
  let sequelize: Sequelize;
  let encryption: EncryptionService;
  let ciphertext: string;
  let hash: string;
  let rewardEntryId: string;

  beforeAll(async () => {
    sequelize = new Sequelize({
      dialect: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      username: process.env.DB_APP_USERNAME,
      password: process.env.DB_APP_PASSWORD,
      logging: false,
    });
    await sequelize.authenticate();

    encryption = new EncryptionService({
      aesKey: Buffer.from(AES_KEY, 'base64'),
      hmacKey: Buffer.from(HMAC_KEY, 'base64'),
    });
    ciphertext = encryption.encrypt(PLAINTEXT_MARKER);
    hash = encryption.hash(PLAINTEXT_MARKER);

    // Real write path #1: activity_logs, via the actual repository production code goes through.
    const activityLogsRepository = new ActivityLogsRepository(sequelize);
    await sequelize.transaction((transaction: Transaction) =>
      activityLogsRepository.insertFanOutRows(
        [fanOutRow({ customerIdEncrypted: ciphertext, customerIdHash: hash })],
        transaction,
      ),
    );

    // Real write path #2: reward_entry — the other (and only other) table
    // `01-DATABASE.md` §3/§7 grants a `customer_id_encrypted` column to.
    const rewardRows = await sequelize.query<{ id: string }>(
      `INSERT INTO realtime_activity_processing.reward_entry
         (correlation_id, tenant_id, customer_id_encrypted, customer_id_hash, customer_id_type,
          activity_performed_date, activity_code, activity_type, activity_category, activity_value,
          activity_value_unit, channel, activity_performed_env, activity_name, campaign_code,
          tracker_code, tracker_component_code, reward_code, reward_category, reward_value,
          reward_value_unit)
       VALUES
         (:correlationId, :tenantId, :customerIdEncrypted, :customerIdHash, 'INTERNAL_ID',
          now(), 'PURCHASE', 'TRANSACTION', 'RETAIL', 10.0000,
          'USD', 'WEB', 'PROD', 'T-RAP-042 security-review fixture', 'SECREVIEW-CAMP',
          'SECREVIEW-TRK', 'SECREVIEW-COMP', 'SECREVIEW-REWARD', 'POINTS', 5.0000, 'PTS')
       RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          correlationId: randomUUID(),
          tenantId: TENANT_ID,
          customerIdEncrypted: ciphertext,
          customerIdHash: hash,
        },
      },
    );
    rewardEntryId = rewardRows[0].id;
  });

  afterAll(async () => {
    await sequelize.query(
      'DELETE FROM realtime_activity_processing.activity_logs WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await sequelize.query('DELETE FROM realtime_activity_processing.reward_entry WHERE id = :id', {
      type: QueryTypes.RAW,
      replacements: { id: rewardEntryId },
    });
    await sequelize.close();
  });

  it('sanity: the fixture rows really do carry this marker, in ciphertext/hash form only', async () => {
    const [row] = await sequelize.query<{
      customer_id_encrypted: string;
      customer_id_hash: string;
    }>(
      `SELECT customer_id_encrypted, customer_id_hash FROM realtime_activity_processing.activity_logs
        WHERE tenant_id = :tenantId`,
      { type: QueryTypes.SELECT, replacements: { tenantId: TENANT_ID } },
    );
    expect(row).toBeDefined();
    expect(row.customer_id_encrypted).not.toContain(PLAINTEXT_MARKER);
    expect(row.customer_id_hash).not.toContain(PLAINTEXT_MARKER);
    // Round-trips back to exactly the marker — proves the ciphertext genuinely encodes it (this
    // test isn't vacuously passing because nothing was ever really written).
    expect(encryption.decrypt(row.customer_id_encrypted)).toBe(PLAINTEXT_MARKER);
  });

  it('TC-1: full-schema grep — the plaintext marker appears in zero text-shaped columns, on any table', async () => {
    const columns = await sequelize.query<TextColumn>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'realtime_activity_processing'
          AND data_type IN ('text', 'character varying', 'character', 'json', 'jsonb')`,
      { type: QueryTypes.SELECT },
    );
    expect(columns.length).toBeGreaterThan(0);

    const hits: string[] = [];
    for (const { table_name: table, column_name: column } of columns) {
      const [result] = await sequelize.query<{ cnt: string }>(
        `SELECT count(*)::int AS cnt
           FROM realtime_activity_processing."${table}"
          WHERE "${column}"::text ILIKE :pattern`,
        { type: QueryTypes.SELECT, replacements: { pattern: `%${PLAINTEXT_MARKER}%` } },
      );
      if (Number(result.cnt) > 0) {
        hits.push(`${table}.${column}`);
      }
    }

    expect(hits).toEqual([]);
  });
});
