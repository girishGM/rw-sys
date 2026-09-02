/**
 * T-PC-002 regression suite. Runs against the real Postgres 16 server documented in root
 * `CLAUDE.md` — the AGENT-PROTOCOL.md §4 gate (`db:migrate && db:rollback && db:migrate`) is
 * run separately as its own bash step and is what actually proves TC-1/R6; this suite assumes
 * the schema is already migrated (as it is by the time `npm test` runs in the completion-report
 * verification sequence) and asserts the constraints/grants that schema carries.
 *
 * Connects as the migration-privileged role for everything except the two permission checks
 * (TC-11/TC-12), which connect as `promo_code_app` itself — the actual, real-Postgres-enforced
 * property, not a mocked/stubbed check (AGENT-PROTOCOL.md §3: "assert the observable property,
 * not the implementation string").
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { createMigrator } from '@/database/umzug';

// A single tenant id shared by every insert this suite makes, so cleanup can target exactly
// (and only) this suite's own rows without touching data any other test/task may have written.
const TENANT_ID = randomUUID();
const ACTOR_ID = randomUUID();

function baseConfigFields(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: TENANT_ID,
    name: `t-pc-002 config ${randomUUID()}`,
    code_length: 8,
    character_set: 'ALPHANUMERIC',
    reward_value_type: 'FIXED_AMOUNT',
    reward_value: 10,
    reward_unit: 'USD',
    created_by: ACTOR_ID,
    updated_by: ACTOR_ID,
    ...overrides,
  };
}

async function insertConfig(
  sequelize: Sequelize,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const f = baseConfigFields(overrides);
  const [row] = await sequelize.query<{ id: string }>(
    `INSERT INTO promo_code.promo_code_config
       (tenant_id, merchant_id, name, code_length, character_set, reward_value_type, reward_value,
        reward_unit, created_by, updated_by, deleted_at)
     VALUES
       (:tenant_id, :merchant_id, :name, :code_length, :character_set, :reward_value_type,
        :reward_value, :reward_unit, :created_by, :updated_by, :deleted_at)
     RETURNING id`,
    {
      type: QueryTypes.SELECT,
      replacements: { deleted_at: null, merchant_id: null, ...f },
    },
  );
  return row.id;
}

describe('T-PC-002 — promo_code schema migrations', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    // Strict FK-safe order: audit/outbox/promo_code (leaves), then campaign_promo_config,
    // then promo_code_config (root) — mirrors the migrations' own reverse-FK drop order.
    await sequelize.query(
      `DELETE FROM promo_code.promo_code_config_audit
         WHERE promo_code_config_id IN (
           SELECT id FROM promo_code.promo_code_config WHERE tenant_id = :tenant_id
         )`,
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.query(
      `DELETE FROM promo_code.promo_code_outbox
         WHERE promo_code_id IN (
           SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenant_id
         )`,
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.query('DELETE FROM promo_code.promo_code WHERE tenant_id = :tenant_id', {
      type: QueryTypes.RAW,
      replacements: { tenant_id: TENANT_ID },
    });
    await sequelize.query(
      'DELETE FROM promo_code.campaign_promo_config WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await sequelize.query('DELETE FROM promo_code.promo_code_config WHERE tenant_id = :tenant_id', {
      type: QueryTypes.RAW,
      replacements: { tenant_id: TENANT_ID },
    });
    await sequelize.close();
  });

  // TC-1: migrating an already-up-to-date DB is a safe, error-free no-op — the real "clean DB"
  // proof is the bash `db:migrate && db:rollback && db:migrate` cycle (R6), evidenced separately
  // in the completion report; this asserts the same migrator code path resolves cleanly here.
  it('TC-1: running the migrator against an already-migrated DB resolves without error', async () => {
    const migrator = createMigrator(sequelize);
    await expect(migrator.up()).resolves.toBeDefined();
  });

  // TC-2. Updated by T-PC-044 to include `grpc_service_identity` (008) alongside the original 5
  // — this test's own job is "every table this schema currently owns exists with the right
  // name," and that set legitimately grew by one; see `grpc-service-identity.spec.ts` for that
  // table's own dedicated constraint/grant coverage.
  it('TC-2: all 6 promo_code tables exist with the correct names', async () => {
    // Selects a second column (`table_schema`) deliberately, not just `table_name` — with the
    // installed pg driver a single-column SELECT comes back as `[[value], [value], ...]`
    // (array-of-arrays) rather than `[{ table_name: value }, ...]` (reproduced live), a driver
    // quirk unrelated to this table's own schema; a second, constant column sidesteps it.
    const rows = await sequelize.query<{ table_name: string; table_schema: string }>(
      `SELECT table_name, table_schema FROM information_schema.tables
         WHERE table_schema = 'promo_code' AND table_name != 'migrations'
         ORDER BY table_name`,
      { type: QueryTypes.SELECT },
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'campaign_promo_config',
      'grpc_service_identity',
      'promo_code',
      'promo_code_config',
      'promo_code_config_audit',
      'promo_code_outbox',
    ]);
  });

  // TC-3
  it('TC-3: rejects code_length below 4', async () => {
    await expect(insertConfig(sequelize, { code_length: 3 })).rejects.toThrow(/code_length/);
  });

  // TC-4
  it('TC-4: rejects code_length above 32', async () => {
    await expect(insertConfig(sequelize, { code_length: 33 })).rejects.toThrow(/code_length/);
  });

  // TC-5. Sequelize wraps a unique-violation into `SequelizeUniqueConstraintError` with a
  // generic top-level `.message` ("Validation error") — the actual Postgres constraint name
  // lives on the wrapped driver error (`.parent.constraint`), not the message `toThrow()` would
  // match against (same shape the portal's own equivalent test, `portal-schema.e2e-spec.ts`
  // TC-7, already documents).
  it('TC-5: rejects a second live row with the same (tenant_id, name)', async () => {
    const name = `t-pc-002 dup ${randomUUID()}`;
    await insertConfig(sequelize, { name });
    await expect(insertConfig(sequelize, { name })).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ constraint: 'uc_promo_code_config_name' }),
    });
  });

  // TC-6
  it('TC-6: a soft-deleted row does not block reusing the same (tenant_id, name)', async () => {
    const name = `t-pc-002 reuse ${randomUUID()}`;
    const firstId = await insertConfig(sequelize, { name });
    await sequelize.query(
      'UPDATE promo_code.promo_code_config SET deleted_at = now() WHERE id = :id',
      { type: QueryTypes.RAW, replacements: { id: firstId } },
    );
    await expect(insertConfig(sequelize, { name })).resolves.toBeDefined();
  });

  // TC-7 / TC-8 share one config id and one bind_ref_id.
  describe('campaign_promo_config uniqueness', () => {
    let configId: string;
    let bindRefId: string;

    beforeEach(async () => {
      configId = await insertConfig(sequelize);
      bindRefId = randomUUID();
    });

    async function insertBinding(status: string): Promise<void> {
      await sequelize.query(
        `INSERT INTO promo_code.campaign_promo_config
           (promo_code_config_id, tenant_id, bind_level, bind_ref_id, status, bound_by)
         VALUES (:configId, :tenant_id, 'CAMPAIGN', :bindRefId, :status, :actor)`,
        {
          type: QueryTypes.RAW,
          replacements: {
            configId,
            tenant_id: TENANT_ID,
            bindRefId,
            status,
            actor: ACTOR_ID,
          },
        },
      );
    }

    // TC-7 — see TC-5's comment on why this matches `.parent.constraint`, not `.message`.
    it('TC-7: rejects a second ACTIVE binding for the same (tenant, level, ref)', async () => {
      await insertBinding('ACTIVE');
      await expect(insertBinding('ACTIVE')).rejects.toMatchObject({
        name: 'SequelizeUniqueConstraintError',
        parent: expect.objectContaining({ constraint: 'uc_campaign_promo_config_active' }),
      });
    });

    // TC-8
    it('TC-8: an INACTIVE binding does not block a new ACTIVE one for the same ref', async () => {
      await insertBinding('INACTIVE');
      await expect(insertBinding('ACTIVE')).resolves.toBeUndefined();
    });
  });

  describe('promo_code uniqueness', () => {
    let configId: string;

    beforeEach(async () => {
      configId = await insertConfig(sequelize);
    });

    async function insertCode(code: string, correlationId: string): Promise<void> {
      await sequelize.query(
        `INSERT INTO promo_code.promo_code
           (promo_code_config_id, code, customer_id, tenant_id, reward_value_type,
            reward_value, reward_unit, correlation_id, transport)
         VALUES
           (:configId, :code, :customerId, :tenant_id, 'FIXED_AMOUNT', 10, 'USD',
            :correlationId, 'KAFKA')`,
        {
          type: QueryTypes.RAW,
          replacements: {
            configId,
            code,
            customerId: `cust-${randomUUID()}`,
            tenant_id: TENANT_ID,
            correlationId,
          },
        },
      );
    }

    // TC-9 — see TC-5's comment on why this matches `.parent.constraint`, not `.message`.
    it('TC-9: rejects a duplicate code', async () => {
      const code = `T-PC-002-${randomUUID()}`;
      await insertCode(code, randomUUID());
      await expect(insertCode(code, randomUUID())).rejects.toMatchObject({
        name: 'SequelizeUniqueConstraintError',
        parent: expect.objectContaining({ constraint: 'uc_promo_code_code' }),
      });
    });

    // TC-10
    it('TC-10: rejects a duplicate correlation_id', async () => {
      const correlationId = randomUUID();
      await insertCode(`T-PC-002-${randomUUID()}`, correlationId);
      await expect(insertCode(`T-PC-002-${randomUUID()}`, correlationId)).rejects.toMatchObject({
        name: 'SequelizeUniqueConstraintError',
        parent: expect.objectContaining({ constraint: 'uc_promo_code_correlation' }),
      });
    });
  });
});

describe('T-PC-052 — portal-sourced id columns widened to varchar(64)', () => {
  let sequelize: Sequelize;

  // The 10 physical (table, column) pairs migration 009 widens — see that migration's own
  // header for why 7 distinct column *names* land on 10 physical columns.
  const WIDENED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
    { table: 'promo_code_config', column: 'tenant_id' },
    { table: 'promo_code_config', column: 'merchant_id' },
    { table: 'promo_code_config', column: 'created_by' },
    { table: 'promo_code_config', column: 'updated_by' },
    { table: 'campaign_promo_config', column: 'tenant_id' },
    { table: 'campaign_promo_config', column: 'bind_ref_id' },
    { table: 'campaign_promo_config', column: 'bound_by' },
    { table: 'promo_code', column: 'tenant_id' },
    { table: 'promo_code', column: 'merchant_id' },
    { table: 'promo_code_config_audit', column: 'changed_by' },
  ];

  // TC-2/TC-6 insert rows with tenant ids that don't match the shared `TENANT_ID` the outer
  // describe block's own `afterAll` cleans up — tracked here and cleaned up independently,
  // FK-safe order (audit/campaign_promo_config/promo_code leaves before promo_code_config root).
  const createdConfigIds: string[] = [];

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    if (createdConfigIds.length > 0) {
      await sequelize.query(
        'DELETE FROM promo_code.promo_code_config_audit WHERE promo_code_config_id IN (:ids)',
        { type: QueryTypes.RAW, replacements: { ids: createdConfigIds } },
      );
      await sequelize.query(
        'DELETE FROM promo_code.promo_code WHERE promo_code_config_id IN (:ids)',
        { type: QueryTypes.RAW, replacements: { ids: createdConfigIds } },
      );
      await sequelize.query(
        'DELETE FROM promo_code.campaign_promo_config WHERE promo_code_config_id IN (:ids)',
        { type: QueryTypes.RAW, replacements: { ids: createdConfigIds } },
      );
      await sequelize.query('DELETE FROM promo_code.promo_code_config WHERE id IN (:ids)', {
        type: QueryTypes.RAW,
        replacements: { ids: createdConfigIds },
      });
    }
    await sequelize.close();
  });

  // TC-1
  it('TC-1: every widened column reports character varying(64) in information_schema', async () => {
    const rows = await sequelize.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      character_maximum_length: number;
    }>(
      `SELECT table_name, column_name, data_type, character_maximum_length
         FROM information_schema.columns
        WHERE table_schema = 'promo_code'
          AND table_name IN (:tables)
          AND column_name IN (:columns)`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          tables: WIDENED_COLUMNS.map((c) => c.table),
          columns: WIDENED_COLUMNS.map((c) => c.column),
        },
      },
    );

    for (const { table, column } of WIDENED_COLUMNS) {
      const row = rows.find((r) => r.table_name === table && r.column_name === column);
      expect(row).toMatchObject({ data_type: 'character varying', character_maximum_length: 64 });
    }
  });

  // TC-2. Proves the DB layer alone no longer rejects a plain, non-UUID-shaped string in any of
  // the 10 widened columns — the actual, real-Postgres-enforced property (AGENT-PROTOCOL.md §3),
  // not a mocked one.
  it('TC-2: a plain numeric-string value inserts cleanly into every widened column', async () => {
    // A fresh bind_ref_id per run (rather than a fixed literal) keeps this test re-runnable
    // without colliding with `uc_campaign_promo_config_active` against a prior, interrupted run.
    const bindRefId = `bind-${randomUUID()}`;
    const configId = await insertConfig(sequelize, {
      tenant_id: '42',
      merchant_id: '43',
      created_by: '44',
      updated_by: '44',
    });
    createdConfigIds.push(configId);
    const [config] = await sequelize.query<{ tenant_id: string; merchant_id: string }>(
      'SELECT tenant_id, merchant_id FROM promo_code.promo_code_config WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id: configId } },
    );
    expect(config).toMatchObject({ tenant_id: '42', merchant_id: '43' });

    await sequelize.query(
      `INSERT INTO promo_code.campaign_promo_config
         (promo_code_config_id, tenant_id, bind_level, bind_ref_id, bound_by)
       VALUES (:configId, '42', 'CAMPAIGN', :bindRefId, '46')`,
      { type: QueryTypes.RAW, replacements: { configId, bindRefId } },
    );
    const [binding] = await sequelize.query<{ bind_ref_id: string; bound_by: string }>(
      `SELECT bind_ref_id, bound_by FROM promo_code.campaign_promo_config
         WHERE promo_code_config_id = :configId`,
      { type: QueryTypes.SELECT, replacements: { configId } },
    );
    expect(binding).toMatchObject({ bind_ref_id: bindRefId, bound_by: '46' });

    await sequelize.query(
      `INSERT INTO promo_code.promo_code
         (promo_code_config_id, code, customer_id, tenant_id, merchant_id, reward_value_type,
          reward_value, reward_unit, correlation_id, transport)
       VALUES
         (:configId, :code, 'cust-t-pc-052', '42', '43', 'FIXED_AMOUNT', 10, 'USD',
          :correlationId, 'KAFKA')`,
      {
        type: QueryTypes.RAW,
        replacements: {
          configId,
          code: `T-PC-052-${randomUUID()}`,
          correlationId: randomUUID(),
        },
      },
    );
    const [code] = await sequelize.query<{ tenant_id: string; merchant_id: string }>(
      `SELECT tenant_id, merchant_id FROM promo_code.promo_code WHERE promo_code_config_id = :configId`,
      { type: QueryTypes.SELECT, replacements: { configId } },
    );
    expect(code).toMatchObject({ tenant_id: '42', merchant_id: '43' });

    await sequelize.query(
      `INSERT INTO promo_code.promo_code_config_audit
         (promo_code_config_id, action, changed_fields, changed_by)
       VALUES (:configId, 'CREATE', '{}'::jsonb, '47')`,
      { type: QueryTypes.RAW, replacements: { configId } },
    );
    const [audit] = await sequelize.query<{ changed_by: string }>(
      `SELECT changed_by FROM promo_code.promo_code_config_audit WHERE promo_code_config_id = :configId`,
      { type: QueryTypes.SELECT, replacements: { configId } },
    );
    expect(audit).toMatchObject({ changed_by: '47' });
  });

  // TC-6. Existing pre-migration UUID-shaped rows (already present from before this migration
  // ran, or inserted here to stand in for one) are still readable/queryable as plain strings
  // post-migration — no data loss from the widen.
  it('TC-6: a UUID-shaped value inserted into a widened column is still readable as a plain string', async () => {
    const uuidLikeTenant = randomUUID();
    const configId = await insertConfig(sequelize, { tenant_id: uuidLikeTenant });
    createdConfigIds.push(configId);
    const [row] = await sequelize.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM promo_code.promo_code_config WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id: configId } },
    );
    expect(row.tenant_id).toBe(uuidLikeTenant);
  });
});

describe('T-PC-057 — promo_code.transport CHECK widened to allow REST', () => {
  let sequelize: Sequelize;
  let configId: string;
  const TENANT_ID = randomUUID();
  const insertedCodes: string[] = [];

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
    configId = await insertConfig(sequelize, { tenant_id: TENANT_ID });
  });

  afterAll(async () => {
    if (insertedCodes.length > 0) {
      await sequelize.query('DELETE FROM promo_code.promo_code WHERE code IN (:codes)', {
        type: QueryTypes.RAW,
        replacements: { codes: insertedCodes },
      });
    }
    await sequelize.query('DELETE FROM promo_code.promo_code_config WHERE id = :id', {
      type: QueryTypes.RAW,
      replacements: { id: configId },
    });
    await sequelize.close();
  });

  async function insertWithTransport(transport: string): Promise<void> {
    const code = `T-PC-057-${randomUUID()}`;
    insertedCodes.push(code);
    await sequelize.query(
      `INSERT INTO promo_code.promo_code
         (promo_code_config_id, code, customer_id, tenant_id, reward_value_type,
          reward_value, reward_unit, correlation_id, transport)
       VALUES
         (:configId, :code, :customerId, :tenant_id, 'FIXED_AMOUNT', 10, 'USD',
          :correlationId, :transport)`,
      {
        type: QueryTypes.RAW,
        replacements: {
          configId,
          code,
          customerId: `cust-${randomUUID()}`,
          tenant_id: TENANT_ID,
          correlationId: randomUUID(),
          transport,
        },
      },
    );
  }

  // TC-2 / TC-3 (this is also the regression test: proven red against the pre-fix schema by
  // reverting migration 010 — see this task's completion report — then proven green again here).
  it("TC-2/TC-3: a 'REST' transport value inserts cleanly", async () => {
    await expect(insertWithTransport('REST')).resolves.toBeUndefined();
  });

  // TC-4: adjacent behaviour — the pre-existing values must still work, and an arbitrary
  // out-of-set value must still be rejected. Proves the widen only adds 'REST', nothing else.
  it('TC-4: KAFKA and GRPC still insert cleanly, and an unrelated value is still rejected', async () => {
    await expect(insertWithTransport('KAFKA')).resolves.toBeUndefined();
    await expect(insertWithTransport('GRPC')).resolves.toBeUndefined();
    await expect(insertWithTransport('BOGUS')).rejects.toMatchObject({
      name: 'SequelizeDatabaseError',
      parent: expect.objectContaining({ constraint: 'promo_code_transport_check' }),
    });
  });
});

describe('T-PC-002 — promo_code_app least-privilege grants (TC-11, TC-12)', () => {
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

  // TC-11
  it('TC-11: promo_code_app cannot SELECT from reward_config', async () => {
    await expect(
      appSequelize.query('SELECT * FROM reward_config.reward_policies LIMIT 1', {
        type: QueryTypes.SELECT,
      }),
    ).rejects.toThrow(/permission denied for schema reward_config/);
  });

  // TC-12
  it('TC-12: promo_code_app cannot CREATE TABLE in promo_code (no DDL grant)', async () => {
    await expect(
      appSequelize.query('CREATE TABLE promo_code.t_pc_002_ddl_probe (id int)', {
        type: QueryTypes.RAW,
      }),
    ).rejects.toThrow(/permission denied for schema promo_code/);
  });

  // Adjacent behaviour: the point of R1 is a *scoped* role, not a useless one — it must still
  // be able to do ordinary reads/writes on its own schema's tables.
  it('adjacent behaviour: promo_code_app can SELECT its own schema', async () => {
    await expect(
      appSequelize.query('SELECT count(*) FROM promo_code.promo_code_config', {
        type: QueryTypes.SELECT,
      }),
    ).resolves.toBeDefined();
  });
});
