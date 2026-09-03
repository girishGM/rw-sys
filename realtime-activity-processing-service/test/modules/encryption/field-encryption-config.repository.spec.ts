/**
 * T-RAP-012. Integration tests against the real local Postgres 16 server (root `CLAUDE.md`),
 * connected as the real least-privilege `rap_app` role — same real-DB convention
 * `campaign-config-snapshot.repository.spec.ts` (T-RAP-010) already established for this
 * project's `agent-rap-cache` file-scope owner.
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { FieldEncryptionConfigRepository } from '@/modules/encryption/field-encryption-config.repository';

// A scope_ref far outside any real campaign code range this repo would ever use, so this
// suite's own rows never collide with T-RAP-003's seeded default ('global', NULL, 'customerId').
const TEST_CAMPAIGN_CODE = `TEST-CAMP-${Math.floor(Math.random() * 1_000_000)}`;

describe('FieldEncryptionConfigRepository (real Postgres, rap_app role)', () => {
  let sequelize: Sequelize;
  let repository: FieldEncryptionConfigRepository;

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
    repository = new FieldEncryptionConfigRepository(sequelize);
  });

  afterAll(async () => {
    await sequelize.query(
      `DELETE FROM realtime_activity_processing.field_encryption_config WHERE scope_ref = :scopeRef`,
      { type: QueryTypes.RAW, replacements: { scopeRef: TEST_CAMPAIGN_CODE } },
    );
    await sequelize.close();
  });

  // TC-4/TC-5's own fixture: T-RAP-003 seeds exactly one row, ('global', NULL, 'customerId', true).
  it('findAll returns the T-RAP-003 seeded default global customerId row', async () => {
    const rows = await repository.findAll();
    const globalCustomerIdRow = rows.find(
      (row) => row.scope_level === 'global' && row.field_name === 'customerId',
    );
    expect(globalCustomerIdRow).toBeDefined();
    expect(globalCustomerIdRow?.scope_ref).toBeNull();
    expect(globalCustomerIdRow?.is_encrypted).toBe(true);
  });

  it('upsert inserts a new campaign-scoped override row', async () => {
    await repository.upsert({
      scopeLevel: 'campaign',
      scopeRef: TEST_CAMPAIGN_CODE,
      fieldName: 'activityValue',
      isEncrypted: true,
      addedBy: 'T-RAP-012-test',
    });

    const rows = await repository.findAll();
    const row = rows.find(
      (r) => r.scope_level === 'campaign' && r.scope_ref === TEST_CAMPAIGN_CODE,
    );
    expect(row).toBeDefined();
    expect(row?.field_name).toBe('activityValue');
    expect(row?.is_encrypted).toBe(true);
  });

  it('upsert on an existing (scope_level, scope_ref, field_name) replaces is_encrypted rather than duplicating the row', async () => {
    await repository.upsert({
      scopeLevel: 'campaign',
      scopeRef: TEST_CAMPAIGN_CODE,
      fieldName: 'activityValue',
      isEncrypted: false,
      addedBy: 'T-RAP-012-test',
    });

    const rows = await repository.findAll();
    const matching = rows.filter(
      (r) => r.scope_level === 'campaign' && r.scope_ref === TEST_CAMPAIGN_CODE,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].is_encrypted).toBe(false);
  });
});
