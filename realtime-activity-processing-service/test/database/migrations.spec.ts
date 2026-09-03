/**
 * T-RAP-002 regression suite. Runs against the real Postgres 16 server documented in root
 * `CLAUDE.md` — the AGENT-PROTOCOL.md §4 gate (`db:migrate && db:rollback && db:migrate`) is run
 * separately as its own bash step and is what actually proves TC-1/TC-5/R7; this suite assumes
 * the schema is already migrated (as it is by the time `npm test` runs in the completion-report
 * verification sequence) and asserts the constraints/grants that schema carries.
 *
 * Connects as the migration-privileged role for everything except the permission checks (TC-6),
 * which connect as `rap_app` itself — the actual, real-Postgres-enforced property, not a
 * mocked/stubbed check (AGENT-PROTOCOL.md §3: "assert the observable property, not the
 * implementation string"). `tenant_id` is a plain `int` per table (01-DATABASE.md §0's "codes,
 * not foreign keys" convention), never a cross-schema FK — a large, randomly-offset value per
 * test run is safe and never collides with real `reward_config.tenants` data.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { createMigrator } from '@/database/umzug';

const TENANT_ID = 900_000 + Math.floor(Math.random() * 99_999);

function baseActivityLogFields(overrides: Record<string, unknown> = {}) {
  return {
    correlation_id: randomUUID(),
    dedup_key: `dedup-${randomUUID()}`,
    tenant_id: TENANT_ID,
    customer_id_encrypted: 'ciphertext-placeholder',
    customer_id_hash: `hash-${randomUUID()}`,
    customer_id_type: 'EMAIL',
    activity_performed_date: new Date(),
    transaction_type: null,
    activity_code: 'ACT_CODE',
    activity_type: 'PURCHASE',
    activity_category: 'SPEND',
    activity_value: 10,
    activity_value_unit: 'USD',
    channel: 'WEB',
    activity_performed_env: 'PROD',
    activity_name: 't-rap-002 activity',
    campaign_code: 'CAMP1',
    tracker_code: 'TRK1',
    tracker_component_code: 'COMP1',
    merchant_code: null,
    source_transport: 'GRPC',
    ...overrides,
  };
}

async function insertActivityLog(
  sequelize: Sequelize,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const f = baseActivityLogFields(overrides);
  const [row] = await sequelize.query<{ id: string }>(
    `INSERT INTO realtime_activity_processing.activity_logs
       (correlation_id, dedup_key, tenant_id, customer_id_encrypted, customer_id_hash,
        customer_id_type, activity_performed_date, transaction_type, activity_code,
        activity_type, activity_category, activity_value, activity_value_unit, channel,
        activity_performed_env, activity_name, campaign_code, tracker_code,
        tracker_component_code, merchant_code, source_transport)
     VALUES
       (:correlation_id, :dedup_key, :tenant_id, :customer_id_encrypted, :customer_id_hash,
        :customer_id_type, :activity_performed_date, :transaction_type, :activity_code,
        :activity_type, :activity_category, :activity_value, :activity_value_unit, :channel,
        :activity_performed_env, :activity_name, :campaign_code, :tracker_code,
        :tracker_component_code, :merchant_code, :source_transport)
     RETURNING id`,
    { type: QueryTypes.SELECT, replacements: f },
  );
  return row.id;
}

function baseRewardEntryFields(overrides: Record<string, unknown> = {}) {
  return {
    correlation_id: randomUUID(),
    tenant_id: TENANT_ID,
    customer_id_encrypted: 'ciphertext-placeholder',
    customer_id_hash: `hash-${randomUUID()}`,
    customer_id_type: 'EMAIL',
    activity_performed_date: new Date(),
    transaction_type: null,
    activity_code: 'ACT_CODE',
    activity_type: 'PURCHASE',
    activity_category: 'SPEND',
    activity_value: 10,
    activity_value_unit: 'USD',
    channel: 'WEB',
    activity_performed_env: 'PROD',
    activity_name: 't-rap-002 reward entry',
    campaign_code: 'CAMP1',
    tracker_code: 'TRK1',
    tracker_component_code: 'COMP1',
    merchant_code: null,
    reward_code: 'RWD1',
    reward_category: 'CASHBACK',
    reward_value: 5,
    reward_value_unit: 'USD',
    completion_cycle: 1,
    ...overrides,
  };
}

async function insertRewardEntry(
  sequelize: Sequelize,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const f = baseRewardEntryFields(overrides);
  const [row] = await sequelize.query<{ id: string }>(
    `INSERT INTO realtime_activity_processing.reward_entry
       (correlation_id, tenant_id, customer_id_encrypted, customer_id_hash, customer_id_type,
        activity_performed_date, transaction_type, activity_code, activity_type,
        activity_category, activity_value, activity_value_unit, channel, activity_performed_env,
        activity_name, campaign_code, tracker_code, tracker_component_code, merchant_code,
        reward_code, reward_category, reward_value, reward_value_unit, completion_cycle)
     VALUES
       (:correlation_id, :tenant_id, :customer_id_encrypted, :customer_id_hash, :customer_id_type,
        :activity_performed_date, :transaction_type, :activity_code, :activity_type,
        :activity_category, :activity_value, :activity_value_unit, :channel,
        :activity_performed_env, :activity_name, :campaign_code, :tracker_code,
        :tracker_component_code, :merchant_code, :reward_code, :reward_category, :reward_value,
        :reward_value_unit, :completion_cycle)
     RETURNING id`,
    { type: QueryTypes.SELECT, replacements: f },
  );
  return row.id;
}

describe('T-RAP-002 — realtime_activity_processing schema migrations', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.query(
      'DELETE FROM realtime_activity_processing.reward_entry WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.query(
      'DELETE FROM realtime_activity_processing.activity_logs WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.close();
  });

  // TC-1: migrating an already-up-to-date DB is a safe, error-free no-op — the real "clean DB"
  // proof is the bash `db:migrate && db:rollback && db:migrate` cycle (R7), evidenced separately
  // in the completion report; this asserts the same migrator code path resolves cleanly here.
  it('TC-1: running the migrator against an already-migrated DB resolves without error', async () => {
    const migrator = createMigrator(sequelize);
    await expect(migrator.up()).resolves.toBeDefined();
  });

  // TC-2: every table from 01-DATABASE.md §1-§11 is present (`\dt realtime_activity_processing.*`
  // equivalent via information_schema, excluding Umzug's own bookkeeping table).
  it('TC-2: all 12 realtime_activity_processing tables exist with the correct names', async () => {
    const rows = await sequelize.query<{ table_name: string; table_schema: string }>(
      `SELECT table_name, table_schema FROM information_schema.tables
         WHERE table_schema = 'realtime_activity_processing' AND table_name != 'migrations'
         ORDER BY table_name`,
      { type: QueryTypes.SELECT },
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'activity_external_code_map',
      'activity_logs',
      'budget_consumption',
      'campaign_config_snapshot',
      'customer_reward_limit_consumption',
      'customer_tracker_component_progress',
      'customer_tracker_status',
      'field_encryption_config',
      'reward_dispatch_retry',
      'reward_entry',
      'reward_entry_outbox',
      'service_config',
    ]);
  });

  // TC-3 — same-shaped fan-out row (dedup_key, campaign_code, tracker_code,
  // tracker_component_code) rejected by uc_activity_logs_fanout, even with a different
  // correlation_id/customer.
  it('TC-3: rejects a second activity_logs row with the same fan-out key', async () => {
    const dedup_key = `dedup-${randomUUID()}`;
    await insertActivityLog(sequelize, { dedup_key });
    await expect(insertActivityLog(sequelize, { dedup_key })).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ constraint: 'uc_activity_logs_fanout' }),
    });
  });

  // TC-4 — same (tenant, customer, campaign, tracker, component, completion_cycle) rejected by
  // uc_reward_entry_completion.
  it('TC-4: rejects a second reward_entry row for the same completion cycle', async () => {
    const customer_id_hash = `hash-${randomUUID()}`;
    await insertRewardEntry(sequelize, { customer_id_hash });
    await expect(insertRewardEntry(sequelize, { customer_id_hash })).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ constraint: 'uc_reward_entry_completion' }),
    });
  });

  // Adjacent behaviour: a repeated completion cycle for the same customer/tracker-component is a
  // *new* reward, not a duplicate — the unique index is scoped by completion_cycle, not just the
  // rest of the tuple.
  it('adjacent behaviour: a different completion_cycle is not blocked by uc_reward_entry_completion', async () => {
    const customer_id_hash = `hash-${randomUUID()}`;
    await insertRewardEntry(sequelize, { customer_id_hash, completion_cycle: 1 });
    await expect(
      insertRewardEntry(sequelize, { customer_id_hash, completion_cycle: 2 }),
    ).resolves.toBeDefined();
  });

  // T-RAP-049 TC-2/TC-3: two *distinct* bound rewards granted on the exact same completion
  // (05-PROCESSING-PIPELINE.md §6, CapEnforcementService.enforceForCompletion, T-RAP-033) must
  // both get their own reward_entry row — reward_code is now part of uc_reward_entry_completion
  // precisely so this no longer collides. This is the regression test: reverting
  // 015_fix_reward_entry_unique_index.ts (or dropping reward_code from its CREATE UNIQUE INDEX)
  // makes this fail with a SequelizeUniqueConstraintError on uc_reward_entry_completion, proven
  // by temporarily reverting the migration and re-running this suite before restoring the fix —
  // see the T-RAP-049 completion report for that run's output.
  it('T-RAP-049 TC-2/TC-3: two distinct reward_code rows for the same completion tuple both insert', async () => {
    const customer_id_hash = `hash-${randomUUID()}`;
    await expect(
      insertRewardEntry(sequelize, { customer_id_hash, reward_code: 'RWD1' }),
    ).resolves.toBeDefined();
    await expect(
      insertRewardEntry(sequelize, { customer_id_hash, reward_code: 'RWD2' }),
    ).resolves.toBeDefined();
  });

  // T-RAP-049 TC-4: adjacent behaviour that must not change — the *same* reward_code on the
  // exact same completion tuple is still rejected as a genuine duplicate. Identical to TC-4 above
  // but stated explicitly against the new 7-column index so a future column reordering can't
  // silently drop this guarantee.
  it('T-RAP-049 TC-4: the same reward_code on the same completion tuple is still rejected', async () => {
    const customer_id_hash = `hash-${randomUUID()}`;
    await insertRewardEntry(sequelize, { customer_id_hash, reward_code: 'RWD1' });
    await expect(
      insertRewardEntry(sequelize, { customer_id_hash, reward_code: 'RWD1' }),
    ).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ constraint: 'uc_reward_entry_completion' }),
    });
  });
});

describe('T-RAP-002 — rap_app least-privilege grants (TC-6)', () => {
  let appSequelize: Sequelize;

  beforeAll(async () => {
    appSequelize = new Sequelize({
      dialect: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      username: process.env.DB_APP_USERNAME,
      password: process.env.DB_APP_PASSWORD,
      logging: false,
    });
    await appSequelize.authenticate();
  });

  afterAll(async () => {
    await appSequelize.close();
  });

  // TC-6
  it('TC-6: rap_app cannot SELECT from reward_config', async () => {
    await expect(
      appSequelize.query('SELECT * FROM reward_config.tenants LIMIT 1', {
        type: QueryTypes.SELECT,
      }),
    ).rejects.toThrow(/permission denied for schema reward_config/);
  });

  // Adjacent behaviour: R1 is a *scoped* role, not a useless one — it must still be able to do
  // ordinary reads/writes on its own schema's tables.
  it('adjacent behaviour: rap_app can SELECT its own schema', async () => {
    await expect(
      appSequelize.query('SELECT count(*) FROM realtime_activity_processing.service_config', {
        type: QueryTypes.SELECT,
      }),
    ).resolves.toBeDefined();
  });

  // Adjacent behaviour: R1's "no DDL" half of the scoped role — rap_app has no CREATE on the
  // schema, only USAGE.
  it('adjacent behaviour: rap_app cannot CREATE TABLE in realtime_activity_processing (no DDL grant)', async () => {
    await expect(
      appSequelize.query('CREATE TABLE realtime_activity_processing.t_rap_002_ddl_probe (id int)', {
        type: QueryTypes.RAW,
      }),
    ).rejects.toThrow(/permission denied for schema realtime_activity_processing/);
  });
});
