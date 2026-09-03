/**
 * T-RAP-042 — TC-4. Independent, real-Postgres proof that `rap_app` (`014_create_rap_app_role.ts`,
 * `AGENT-PROTOCOL.md` R1) really is confined to the `realtime_activity_processing` schema on the
 * shared `reward_system` database — not just "the migration's `GRANT`/`REVOKE` statements read like
 * they should do that", this task's own Implementation note 1 ("actually attempt the bad case").
 *
 * Connects directly with the real `rap_app` credentials from the environment (same connection
 * shape every other real-Postgres spec in this project uses) and attempts a live cross-schema read
 * against each of the three sibling schemas this server also hosts (`reward_config`, `reward_portal`,
 * `promo_code` — `01-DATABASE.md` §0/`ARCHITECTURE.md` §4), plus a same-schema DDL attempt (`rap_app`
 * has `USAGE`, deliberately never `CREATE`, on its own schema).
 */
import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

async function attempt(
  sequelize: Sequelize,
  sql: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    await sequelize.query(sql, { type: QueryTypes.RAW });
    return { ok: true, message: '' };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

describe('T-RAP-042 TC-4 — rap_app is confined to realtime_activity_processing (real Postgres)', () => {
  let sequelize: Sequelize;

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
  });

  afterAll(async () => {
    await sequelize.close();
  });

  it('can read its own schema (sanity — proves the connection/role itself works at all)', async () => {
    const result = await attempt(
      sequelize,
      'SELECT count(*) FROM realtime_activity_processing.activity_logs',
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ['reward_config', 'tenants'],
    ['reward_portal', 'portal_user_credentials'],
    ['promo_code', 'promo_code'],
  ])(
    'is rejected reading %s.%s (permission denied, not merely empty results)',
    async (schema, table) => {
      const result = await attempt(sequelize, `SELECT * FROM ${schema}.${table} LIMIT 1`);
      expect(result.ok).toBe(false);
      expect(result.message.toLowerCase()).toContain('permission denied');
    },
  );

  it('is rejected issuing DDL against its own schema (USAGE only, never CREATE — R1)', async () => {
    const result = await attempt(
      sequelize,
      'CREATE TABLE realtime_activity_processing.t_rap_042_should_never_exist (id int)',
    );
    expect(result.ok).toBe(false);
    expect(result.message.toLowerCase()).toContain('permission denied');
  });
});
