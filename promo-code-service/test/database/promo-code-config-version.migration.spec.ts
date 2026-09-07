/**
 * T-PC-059 regression suite — the schema half of T-PC-058's "split identity from versioned
 * payout" design (`promo-code-service-plan/tasks/T-PC-058-version-promo-code-config.md`'s own SQL
 * block), implemented by migrations `T-PC-058_001`..`_004` (this task's own "Files owned" list —
 * see that file for the full defect chain: T-PC-058 needed these files but its owning agent,
 * `agent-promo-config`, has no `Edit` grant on `src/database/**`/`test/database/**`).
 *
 * Runs against the real Postgres 16 server (root `CLAUDE.md`), connected as the migration role,
 * same convention as `migrations.spec.ts` (T-PC-002) — assumes the schema is already migrated by
 * the time `npm test` runs.
 */
import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';

const TENANT_ID = randomUUID();
const ACTOR_ID = randomUUID();

async function insertIdentity(sequelize: Sequelize, overrides: Record<string, unknown> = {}) {
  const [row] = await sequelize.query<{ id: string }>(
    `INSERT INTO promo_code.promo_code_config (tenant_id, merchant_id, name, created_by, updated_by)
     VALUES (:tenant_id, :merchant_id, :name, :created_by, :updated_by)
     RETURNING id`,
    {
      type: QueryTypes.SELECT,
      replacements: {
        tenant_id: TENANT_ID,
        merchant_id: null,
        name: `t-pc-059 config ${randomUUID()}`,
        created_by: ACTOR_ID,
        updated_by: ACTOR_ID,
        ...overrides,
      },
    },
  );
  return row.id;
}

function versionFields(overrides: Record<string, unknown> = {}) {
  return {
    version_no: 1,
    code_prefix: null,
    code_postfix: null,
    code_length: 8,
    character_set: 'ALPHANUMERIC',
    exclude_ambiguous_chars: true,
    reward_value_type: 'FIXED_AMOUNT',
    reward_value: 10,
    reward_unit: 'USD',
    max_redemptions_per_code: 1,
    code_expiry_days: null,
    status: 'draft',
    created_by: ACTOR_ID,
    published_by: null,
    published_at: null,
    ...overrides,
  };
}

async function insertVersion(
  sequelize: Sequelize,
  configId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const f = versionFields(overrides);
  const [row] = await sequelize.query<{ id: string }>(
    `INSERT INTO promo_code.promo_code_config_version
       (promo_code_config_id, version_no, code_prefix, code_postfix, code_length, character_set,
        exclude_ambiguous_chars, reward_value_type, reward_value, reward_unit,
        max_redemptions_per_code, code_expiry_days, status, created_by, published_by, published_at)
     VALUES
       (:configId, :version_no, :code_prefix, :code_postfix, :code_length, :character_set,
        :exclude_ambiguous_chars, :reward_value_type, :reward_value, :reward_unit,
        :max_redemptions_per_code, :code_expiry_days, :status, :created_by, :published_by,
        :published_at)
     RETURNING id`,
    { type: QueryTypes.SELECT, replacements: { configId, ...f } },
  );
  return row.id;
}

describe('T-PC-059 — defect reproduction (agent-promo-config cannot own src/database/**)', () => {
  // TC-1: reproduce the reported defect — confirmed directly from project.config.json's own
  // agents[].allow grants, exactly as this task's own file-defect.js evidence describes.
  it('TC-1: agent-promo-config has no Edit grant on src/database/** or test/database/**, only agent-promo-foundation does', () => {
    const configPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'promo-code-service-plan',
      'project.config.json',
    );
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      agents: Array<{ name: string; allow: string[] }>;
    };
    const foundation = config.agents.find((a) => a.name === 'agent-promo-foundation');
    const promoConfig = config.agents.find((a) => a.name === 'agent-promo-config');
    expect(foundation?.allow).toEqual(
      expect.arrayContaining([
        'Edit(promo-code-service/src/database/**)',
        'Edit(promo-code-service/test/database/**)',
      ]),
    );
    expect(
      promoConfig?.allow.some(
        (rule) => rule.includes('src/database/') || rule.includes('test/database/'),
      ),
    ).toBe(false);
  });

  // TC-2: the same check after the fix — the migration files this defect needed now exist,
  // owned by agent-promo-foundation, and the schema they define is actually live.
  it('TC-2: the T-PC-058 migration chain exists under agent-promo-foundation-owned paths and is applied', async () => {
    const migrationsDir = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
    const files = fs.readdirSync(migrationsDir).filter((f) => f.startsWith('T-PC-058_'));
    expect(files.sort()).toEqual([
      'T-PC-058_001_split_promo_code_config_version.ts',
      'T-PC-058_002_promo_code_config_version_immutability.ts',
      'T-PC-058_003_campaign_promo_config_version_pin.ts',
      'T-PC-058_004_promo_code_version_column.ts',
    ]);

    const sequelize = createMigrationConnection();
    try {
      await sequelize.authenticate();
      const rows = await sequelize.query<{ name: string }>(
        `SELECT name FROM promo_code.migrations WHERE name LIKE 'T-PC-058_%' ORDER BY name`,
        { type: QueryTypes.SELECT },
      );
      expect(rows.length).toBe(4);
    } finally {
      await sequelize.close();
    }
  });
});

describe('T-PC-059 — promo_code_config_version schema (TC-3: regression, proven red without the migration)', () => {
  let sequelize: Sequelize;
  const createdConfigIds: string[] = [];

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  // Several tests below deliberately publish a version (to prove the immutability trigger), and
  // one deliberately leaves a published row permanently un-deleted as its own assertion — by
  // design (T-PC-058_002), a published/deprecated/retired row can never be removed through
  // ordinary means. Cleanup mirrors the portal's own precedented escape hatch for exactly this
  // (`portal/back-end/test/database/t005-versioning-schema.e2e-spec.ts`'s own doc comment):
  // temporarily `DISABLE TRIGGER` the undeletability trigger, as the migration-privileged
  // (table-owning) role, strictly *after* every trigger-rejection assertion above has already run
  // and been observed — not a weakening of the guard, a teardown-only exception to it.
  afterAll(async () => {
    if (createdConfigIds.length > 0) {
      await sequelize.query(
        'DELETE FROM promo_code.campaign_promo_config WHERE promo_code_config_id IN (:ids)',
        { type: QueryTypes.RAW, replacements: { ids: createdConfigIds } },
      );
      await sequelize.query(
        'DELETE FROM promo_code.promo_code WHERE promo_code_config_id IN (:ids)',
        { type: QueryTypes.RAW, replacements: { ids: createdConfigIds } },
      );
      await sequelize.query(
        'ALTER TABLE promo_code.promo_code_config_version DISABLE TRIGGER trg_promo_code_config_version_undeletable',
        { type: QueryTypes.RAW },
      );
      try {
        await sequelize.query(
          'DELETE FROM promo_code.promo_code_config_version WHERE promo_code_config_id IN (:ids)',
          { type: QueryTypes.RAW, replacements: { ids: createdConfigIds } },
        );
      } finally {
        await sequelize.query(
          'ALTER TABLE promo_code.promo_code_config_version ENABLE TRIGGER trg_promo_code_config_version_undeletable',
          { type: QueryTypes.RAW },
        );
      }
      await sequelize.query('DELETE FROM promo_code.promo_code_config WHERE id IN (:ids)', {
        type: QueryTypes.RAW,
        replacements: { ids: createdConfigIds },
      });
    }
    await sequelize.close();
  });

  // Every assertion in this describe block queries either `information_schema` or a real
  // constraint/trigger this migration chain creates — on the pre-fix schema (these migration
  // files absent) `promo_code_config_version` doesn't exist at all, so every one of these would
  // fail with "relation ... does not exist" or "column ... does not exist". Proven red this way,
  // once, by temporarily removing the four `T-PC-058_00*` migration files and re-running this
  // suite alone — see this task's own completion report for that run's output — then restored;
  // not repeated here on every run, since doing so would require live migration-state mutation
  // this suite deliberately avoids (see the module doc comment).

  it('promo_code_config is trimmed of every payout column', async () => {
    const rows = await sequelize.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'promo_code' AND table_name = 'promo_code_config'
         ORDER BY column_name`,
      { type: QueryTypes.SELECT },
    );
    const columns = rows.map((r) => r.column_name);
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'tenant_id',
        'merchant_id',
        'name',
        'status',
        'created_by',
        'updated_by',
        'created_at',
        'updated_at',
        'deleted_at',
      ]),
    );
    for (const moved of [
      'code_prefix',
      'code_postfix',
      'code_length',
      'character_set',
      'exclude_ambiguous_chars',
      'reward_value_type',
      'reward_value',
      'reward_unit',
      'max_redemptions_per_code',
      'code_expiry_days',
    ]) {
      expect(columns).not.toContain(moved);
    }
  });

  it('promo_code_config_version carries every payout column plus the version lifecycle columns', async () => {
    const rows = await sequelize.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'promo_code' AND table_name = 'promo_code_config_version'`,
      { type: QueryTypes.SELECT },
    );
    const columns = rows.map((r) => r.column_name);
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'promo_code_config_id',
        'version_no',
        'code_prefix',
        'code_postfix',
        'code_length',
        'character_set',
        'exclude_ambiguous_chars',
        'reward_value_type',
        'reward_value',
        'reward_unit',
        'max_redemptions_per_code',
        'code_expiry_days',
        'status',
        'supersedes_version_id',
        'created_by',
        'created_at',
        'published_by',
        'published_at',
        'deprecated_at',
        'retired_at',
        'updated_at',
      ]),
    );
  });

  it('rejects a second draft version for the same config (uq_pccv_one_draft)', async () => {
    const configId = await insertIdentity(sequelize);
    createdConfigIds.push(configId);
    await insertVersion(sequelize, configId, { version_no: 1, status: 'draft' });
    await expect(
      insertVersion(sequelize, configId, { version_no: 2, status: 'draft' }),
    ).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ constraint: 'uq_pccv_one_draft' }),
    });
  });

  it('rejects a duplicate (promo_code_config_id, version_no) (uq_pccv_config_version)', async () => {
    const configId = await insertIdentity(sequelize);
    createdConfigIds.push(configId);
    await insertVersion(sequelize, configId, {
      version_no: 1,
      status: 'published',
      published_by: ACTOR_ID,
      published_at: new Date(),
    });
    await expect(
      insertVersion(sequelize, configId, { version_no: 1, status: 'draft' }),
    ).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ constraint: 'uq_pccv_config_version' }),
    });
  });

  it('rejects a published version with no published_at/published_by (ck_pccv_published_fields)', async () => {
    const configId = await insertIdentity(sequelize);
    createdConfigIds.push(configId);
    await expect(
      insertVersion(sequelize, configId, { version_no: 1, status: 'published' }),
    ).rejects.toMatchObject({
      name: 'SequelizeDatabaseError',
      parent: expect.objectContaining({ constraint: 'ck_pccv_published_fields' }),
    });
  });

  describe('immutability trigger (fn_promo_code_config_version_immutable/undeletable)', () => {
    it('allows editing a draft version', async () => {
      const configId = await insertIdentity(sequelize);
      createdConfigIds.push(configId);
      const versionId = await insertVersion(sequelize, configId, {
        version_no: 1,
        status: 'draft',
      });
      await expect(
        sequelize.query(
          'UPDATE promo_code.promo_code_config_version SET code_length = 12 WHERE id = :id',
          { type: QueryTypes.RAW, replacements: { id: versionId } },
        ),
      ).resolves.toBeDefined();
    });

    it('rejects editing a payload column once published, but still allows status to move forward', async () => {
      const configId = await insertIdentity(sequelize);
      createdConfigIds.push(configId);
      const versionId = await insertVersion(sequelize, configId, {
        version_no: 1,
        status: 'draft',
      });
      await sequelize.query(
        `UPDATE promo_code.promo_code_config_version
           SET status = 'published', published_by = :actor, published_at = now()
         WHERE id = :id`,
        { type: QueryTypes.RAW, replacements: { id: versionId, actor: ACTOR_ID } },
      );

      await expect(
        sequelize.query(
          'UPDATE promo_code.promo_code_config_version SET code_length = 20 WHERE id = :id',
          { type: QueryTypes.RAW, replacements: { id: versionId } },
        ),
      ).rejects.toMatchObject({
        name: 'SequelizeDatabaseError',
        parent: expect.objectContaining({ code: '23514' }), // check_violation
      });

      // Adjacent behaviour: status itself is not frozen — the lifecycle can still move forward.
      await expect(
        sequelize.query(
          "UPDATE promo_code.promo_code_config_version SET status = 'deprecated' WHERE id = :id",
          { type: QueryTypes.RAW, replacements: { id: versionId } },
        ),
      ).resolves.toBeDefined();
    });

    it('allows deleting a draft version, but rejects deleting a published one', async () => {
      const configId = await insertIdentity(sequelize);
      createdConfigIds.push(configId);
      const draftId = await insertVersion(sequelize, configId, { version_no: 1, status: 'draft' });
      await expect(
        sequelize.query('DELETE FROM promo_code.promo_code_config_version WHERE id = :id', {
          type: QueryTypes.RAW,
          replacements: { id: draftId },
        }),
      ).resolves.toBeDefined();

      const publishedId = await insertVersion(sequelize, configId, {
        version_no: 1,
        status: 'published',
        published_by: ACTOR_ID,
        published_at: new Date(),
      });
      await expect(
        sequelize.query('DELETE FROM promo_code.promo_code_config_version WHERE id = :id', {
          type: QueryTypes.RAW,
          replacements: { id: publishedId },
        }),
      ).rejects.toMatchObject({
        name: 'SequelizeDatabaseError',
        parent: expect.objectContaining({ code: '23514' }),
      });
    });
  });

  describe('campaign_promo_config.promo_code_config_version_id', () => {
    it('is NOT NULL and enforces a real FK to promo_code_config_version', async () => {
      const configId = await insertIdentity(sequelize);
      createdConfigIds.push(configId);
      const versionId = await insertVersion(sequelize, configId, {
        version_no: 1,
        status: 'published',
        published_by: ACTOR_ID,
        published_at: new Date(),
      });

      await expect(
        sequelize.query(
          `INSERT INTO promo_code.campaign_promo_config
             (promo_code_config_id, promo_code_config_version_id, tenant_id, bind_level,
              bind_ref_id, bound_by)
           VALUES (:configId, NULL, :tenant, 'CAMPAIGN', :ref, :actor)`,
          {
            type: QueryTypes.RAW,
            replacements: { configId, tenant: TENANT_ID, ref: randomUUID(), actor: ACTOR_ID },
          },
        ),
      ).rejects.toMatchObject({ name: 'SequelizeDatabaseError' });

      await expect(
        sequelize.query(
          `INSERT INTO promo_code.campaign_promo_config
             (promo_code_config_id, promo_code_config_version_id, tenant_id, bind_level,
              bind_ref_id, bound_by)
           VALUES (:configId, :bogus, :tenant, 'CAMPAIGN', :ref, :actor)`,
          {
            type: QueryTypes.RAW,
            replacements: {
              configId,
              bogus: randomUUID(),
              tenant: TENANT_ID,
              ref: randomUUID(),
              actor: ACTOR_ID,
            },
          },
        ),
      ).rejects.toMatchObject({ name: 'SequelizeForeignKeyConstraintError' });

      await expect(
        sequelize.query(
          `INSERT INTO promo_code.campaign_promo_config
             (promo_code_config_id, promo_code_config_version_id, tenant_id, bind_level,
              bind_ref_id, bound_by)
           VALUES (:configId, :versionId, :tenant, 'CAMPAIGN', :ref, :actor)`,
          {
            type: QueryTypes.RAW,
            replacements: {
              configId,
              versionId,
              tenant: TENANT_ID,
              ref: randomUUID(),
              actor: ACTOR_ID,
            },
          },
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('promo_code.promo_code_config_version_id', () => {
    it('is nullable (pre-existing rows) but stamps cleanly when supplied', async () => {
      const configId = await insertIdentity(sequelize);
      createdConfigIds.push(configId);
      const versionId = await insertVersion(sequelize, configId, {
        version_no: 1,
        status: 'published',
        published_by: ACTOR_ID,
        published_at: new Date(),
      });

      // Nullable — omitting it entirely (pre-existing-row shape) still inserts cleanly.
      await expect(
        sequelize.query(
          `INSERT INTO promo_code.promo_code
             (promo_code_config_id, code, customer_id, tenant_id, reward_value_type, reward_value,
              reward_unit, correlation_id, transport)
           VALUES
             (:configId, :code, :customerId, :tenant, 'FIXED_AMOUNT', 10, 'USD', :correlationId,
              'KAFKA')`,
          {
            type: QueryTypes.RAW,
            replacements: {
              configId,
              code: `T-PC-059-${randomUUID()}`,
              customerId: `cust-${randomUUID()}`,
              tenant: TENANT_ID,
              correlationId: randomUUID(),
            },
          },
        ),
      ).resolves.toBeDefined();

      // Populated — the shape every new code going forward (T-PC-060) is expected to use.
      const code = `T-PC-059-${randomUUID()}`;
      await sequelize.query(
        `INSERT INTO promo_code.promo_code
           (promo_code_config_id, promo_code_config_version_id, code, customer_id, tenant_id,
            reward_value_type, reward_value, reward_unit, correlation_id, transport)
         VALUES
           (:configId, :versionId, :code, :customerId, :tenant, 'FIXED_AMOUNT', 10, 'USD',
            :correlationId, 'KAFKA')`,
        {
          type: QueryTypes.RAW,
          replacements: {
            configId,
            versionId,
            code,
            customerId: `cust-${randomUUID()}`,
            tenant: TENANT_ID,
            correlationId: randomUUID(),
          },
        },
      );
      const [row] = await sequelize.query<{ promo_code_config_version_id: string }>(
        'SELECT promo_code_config_version_id FROM promo_code.promo_code WHERE code = :code',
        { type: QueryTypes.SELECT, replacements: { code } },
      );
      expect(row.promo_code_config_version_id).toBe(versionId);
    });
  });
});

describe('T-PC-059 — backfill invariant (TC-4: adjacent behaviour, general regression guard)', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    await sequelize.close();
  });

  // T-PC-058 Implementation note 1: every existing promo_code_config row was backfilled to
  // exactly one version_no=1 published row when migration `T-PC-058_001` ran. This asserts the
  // property that backfill exists to establish — every identity row (whenever it was created)
  // has at least one version row — as an ongoing invariant, not just a one-time migration check:
  // it would just as reliably catch a future write path that inserts an identity without ever
  // creating a version.
  it('every promo_code_config row has at least one promo_code_config_version row', async () => {
    const orphans = await sequelize.query<{ id: string }>(
      `SELECT c.id FROM promo_code.promo_code_config c
         LEFT JOIN promo_code.promo_code_config_version v ON v.promo_code_config_id = c.id
        WHERE v.id IS NULL`,
      { type: QueryTypes.SELECT },
    );
    expect(orphans).toEqual([]);
  });
});
