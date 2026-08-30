/**
 * T-119 regression suite — `reward_versions.reward_kind`/`value_config` (`T119_001`) and the
 * immutability-trigger extension that freezes them once a version is published (`T119_002`).
 * Runs against a real Postgres instance and assumes the migrations are applied, the same
 * convention `t005-versioning-schema.e2e-spec.ts` documents for its own suite.
 *
 * Why these cases live here and not in a unit test: every property below is one only the
 * *database* can be trusted to hold — the CHECK constraint, the trigger, and the exact bytes a
 * JSON-in-`text` column ends up holding after Sequelize's own bulk-`UPDATE` path has run the
 * model's setter. A fake repository would happily agree with whatever this code believes
 * (AGENT-PROTOCOL §3: assert the observable property, not the implementation string).
 *
 * Fixtures are a throwaway `reward_systems` row (`ZT119_*`) plus its own versions, never a
 * pre-existing reward: `uq_rewv_one_draft` allows exactly one draft per reward, so borrowing a
 * real one would make this suite fight whatever else is mid-authoring on the shared dev database.
 * Teardown temporarily disables `trg_reward_versions_undeletable` for the same reason, and with
 * the same justification, that T-005's suite does — a published version is undeletable by design,
 * and every assertion has already run by then.
 */
import 'reflect-metadata';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { RewardVersion } from '@/database/models';
import { buildAppSequelize } from './build-app-sequelize';

const MULTI_CURRENCY_CONFIG = {
  multiCurrency: true,
  currencyValues: [
    { currency: 'MYR', value: 10 },
    { currency: 'SGD', value: 3.5 },
  ],
};

describe('T-119 — reward version Kind + value-config columns', () => {
  let migration: Sequelize;
  let app: Sequelize;
  let tenantId: number;
  let rewardSystemId: number;
  const versionIds: number[] = [];

  async function selectOne<T extends object>(sql: string): Promise<T> {
    const [row] = await migration.query<T>(sql, { type: QueryTypes.SELECT });
    return row;
  }

  /** Inserts a `draft` version of the throwaway reward and returns its id. */
  async function insertDraft(
    versionNo: number,
    kind: string | null,
    config: string,
  ): Promise<number> {
    const row = await selectOne<{ id: number }>(
      `INSERT INTO reward_config.reward_versions
         (reward_id, version_no, status, created_by, reward_kind, value_config)
       VALUES (${rewardSystemId}, ${versionNo}, 'draft', 1,
               ${kind === null ? 'NULL' : `'${kind}'`}, ${config})
       RETURNING id`,
    );
    versionIds.push(row.id);
    return row.id;
  }

  async function publish(versionId: number): Promise<void> {
    await migration.query(
      `UPDATE reward_config.reward_versions
          SET status = 'published', published_at = now(), published_by = 1
        WHERE id = ${versionId}`,
      { type: QueryTypes.RAW },
    );
  }

  beforeAll(async () => {
    migration = createMigrationConnection();
    await migration.authenticate();
    app = buildAppSequelize();
    await app.authenticate();

    tenantId = (
      await selectOne<{ id: number }>(`SELECT id FROM reward_config.tenants ORDER BY id LIMIT 1`)
    ).id;
    rewardSystemId = (
      await selectOne<{ id: number }>(
        `INSERT INTO reward_config.reward_systems
           (tenant_id, system_code, name, reward_type, connector_type)
         VALUES (${tenantId}, 'ZT119_KIND_FIXTURE', 'ZT119 kind fixture', 'cashback', 'internal_api')
         RETURNING id`,
      )
    ).id;
  });

  afterAll(async () => {
    // Superuser-only teardown — see this file's own doc comment, and T-005's.
    await migration.query(
      `ALTER TABLE reward_config.reward_versions DISABLE TRIGGER trg_reward_versions_undeletable`,
      { type: QueryTypes.RAW },
    );
    try {
      if (versionIds.length > 0) {
        await migration.query(
          `DELETE FROM reward_config.reward_versions WHERE id IN (${versionIds.join(',')})`,
          { type: QueryTypes.RAW },
        );
      }
      await migration.query(
        `DELETE FROM reward_config.reward_systems WHERE id = ${rewardSystemId}`,
        { type: QueryTypes.RAW },
      );
    } finally {
      await migration.query(
        `ALTER TABLE reward_config.reward_versions ENABLE TRIGGER trg_reward_versions_undeletable`,
        { type: QueryTypes.RAW },
      );
    }
    await app.close();
    await migration.close();
  });

  describe('T119_001 — the two columns', () => {
    it('adds reward_kind varchar(20) NULL and value_config text NULL', async () => {
      const columns = await migration.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        character_maximum_length: number | null;
      }>(
        `SELECT column_name, data_type, is_nullable, character_maximum_length
           FROM information_schema.columns
          WHERE table_schema = 'reward_config' AND table_name = 'reward_versions'
            AND column_name IN ('reward_kind','value_config')
          ORDER BY column_name`,
        { type: QueryTypes.SELECT },
      );

      expect(columns).toEqual([
        {
          column_name: 'reward_kind',
          data_type: 'character varying',
          is_nullable: 'YES',
          character_maximum_length: 20,
        },
        {
          column_name: 'value_config',
          data_type: 'text',
          is_nullable: 'YES',
          character_maximum_length: null,
        },
      ]);
    });

    it('ck_rewv_reward_kind accepts all five Kinds', async () => {
      for (const [index, kind] of [
        'FIXED_AMOUNT',
        'PERCENTAGE',
        'POINTS',
        'PHYSICAL',
        'PROMO_CODE',
      ].entries()) {
        const id = await insertDraft(100 + index, kind, `'{}'`);
        // One draft per reward (`uq_rewv_one_draft`) — publish each before the next is inserted.
        await publish(id);
      }

      const { count } = await selectOne<{ count: string }>(
        `SELECT count(*)::text AS count FROM reward_config.reward_versions
          WHERE reward_id = ${rewardSystemId} AND reward_kind IS NOT NULL`,
      );
      expect(count).toBe('5');
    });

    it('ck_rewv_reward_kind rejects a Kind outside the vocabulary', async () => {
      await expect(
        migration.query(
          `INSERT INTO reward_config.reward_versions
             (reward_id, version_no, status, created_by, reward_kind)
           VALUES (${rewardSystemId}, 199, 'draft', 1, 'GIFT_CARD')`,
          { type: QueryTypes.RAW },
        ),
      ).rejects.toThrow(/ck_rewv_reward_kind/);
    });

    it('TC-7 — a row with reward_kind NULL reads back through the model with both halves null', async () => {
      const id = await insertDraft(200, null, 'NULL');

      const version = await RewardVersion.findByPk(id);

      expect(version?.rewardKind).toBeNull();
      expect(version?.valueConfig).toBeNull();
      await publish(id);
    });

    it('round-trips a value config through the model as JSON text, not "[object Object]"', async () => {
      const id = await insertDraft(201, null, 'NULL');

      await RewardVersion.update(
        { rewardKind: 'FIXED_AMOUNT', valueConfig: MULTI_CURRENCY_CONFIG },
        { where: { id } },
      );

      // The raw bytes, read on the migration connection — the property a future reader of this
      // column (or the transaction microservice) actually depends on.
      const stored = await selectOne<{ reward_kind: string; value_config: string }>(
        `SELECT reward_kind, value_config FROM reward_config.reward_versions WHERE id = ${id}`,
      );
      expect(stored.reward_kind).toBe('FIXED_AMOUNT');
      expect(JSON.parse(stored.value_config)).toEqual(MULTI_CURRENCY_CONFIG);

      const reread = await RewardVersion.findByPk(id);
      expect(reread?.valueConfig).toEqual(MULTI_CURRENCY_CONFIG);
      await publish(id);
    });
  });

  describe('T119_002 — the extended immutability trigger', () => {
    it('TC-6 — a published version’s value_config cannot be changed', async () => {
      const id = await insertDraft(300, 'POINTS', `'{"points":500}'`);
      await publish(id);

      await expect(
        migration.query(
          `UPDATE reward_config.reward_versions
              SET value_config = '{"points":999999}' WHERE id = ${id}`,
          { type: QueryTypes.RAW },
        ),
      ).rejects.toThrow(/is published and immutable/);

      const after = await selectOne<{ value_config: string }>(
        `SELECT value_config FROM reward_config.reward_versions WHERE id = ${id}`,
      );
      expect(JSON.parse(after.value_config)).toEqual({ points: 500 });
    });

    it('TC-6 — a published version’s reward_kind cannot be changed', async () => {
      const id = await insertDraft(301, 'POINTS', `'{"points":500}'`);
      await publish(id);

      await expect(
        migration.query(
          `UPDATE reward_config.reward_versions SET reward_kind = 'PERCENTAGE' WHERE id = ${id}`,
          { type: QueryTypes.RAW },
        ),
      ).rejects.toThrow(/is published and immutable/);
    });

    it('still freezes everything T005_007 froze — connector_config on a published row', async () => {
      const id = await insertDraft(302, 'POINTS', `'{"points":500}'`);
      await publish(id);

      await expect(
        migration.query(
          `UPDATE reward_config.reward_versions SET connector_config = '{"x":1}' WHERE id = ${id}`,
          { type: QueryTypes.RAW },
        ),
      ).rejects.toThrow(/is published and immutable/);
    });

    it('leaves a draft freely editable, and still allows the lifecycle to move forward', async () => {
      const id = await insertDraft(303, 'PERCENTAGE', `'{"percentage":10}'`);

      await migration.query(
        `UPDATE reward_config.reward_versions
            SET reward_kind = 'POINTS', value_config = '{"points":5}' WHERE id = ${id}`,
        { type: QueryTypes.RAW },
      );
      const edited = await selectOne<{ reward_kind: string }>(
        `SELECT reward_kind FROM reward_config.reward_versions WHERE id = ${id}`,
      );
      expect(edited.reward_kind).toBe('POINTS');

      // `status` itself may still move along the lifecycle once published (T-005's TC-8).
      await publish(id);
      await migration.query(
        `UPDATE reward_config.reward_versions
            SET status = 'deprecated', deprecated_at = now() WHERE id = ${id}`,
        { type: QueryTypes.RAW },
      );
      const deprecated = await selectOne<{ status: string }>(
        `SELECT status FROM reward_config.reward_versions WHERE id = ${id}`,
      );
      expect(deprecated.status).toBe('deprecated');
    });
  });
});
