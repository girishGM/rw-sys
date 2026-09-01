/**
 * T-PC-044 regression suite — the migration this task adds
 * (`008_create_promo_code_service_identity.ts`), following the same real-Postgres-assertion
 * style as `migrations.spec.ts` (T-PC-002): connects as the migration-privileged role for the
 * schema assertions, and as `promo_code_app` itself for the one grant check, per
 * AGENT-PROTOCOL.md §3 ("assert the observable property, not the implementation string").
 *
 * TC-1/TC-2 double as the reproduction/fix pair the task file asks for: TC-1 (run against the
 * pre-fix tree) fails with `relation "promo_code.grpc_service_identity" does not exist` because
 * the table this suite queries didn't exist yet (T-PC-031's own reproduced defect, T-PC-044's
 * evidence). Once 008 lands, the same query is TC-2's "6 tables including the new one" assertion
 * and passes. TC-3 (`uc_gsi_identity`) is the regression test proper — proven red against the
 * pre-fix tree for the same reason (no table, so no constraint to violate: an insert `.rejects`
 * for the wrong reason, "relation does not exist", not the constraint-name match this test
 * actually asserts) and green once 008 is applied.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';

const ACTOR_ID = randomUUID();

async function insertIdentity(
  sequelize: Sequelize,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const fields = {
    service_identity: `t-pc-044-${randomUUID()}`,
    description: 'T-PC-044 regression suite',
    created_by: ACTOR_ID,
    ...overrides,
  };
  const [row] = await sequelize.query<{ id: string }>(
    `INSERT INTO promo_code.grpc_service_identity (service_identity, description, created_by)
     VALUES (:service_identity, :description, :created_by)
     RETURNING id`,
    { type: QueryTypes.SELECT, replacements: fields },
  );
  return row.id;
}

describe('T-PC-044 — grpc_service_identity migration (008)', () => {
  let sequelize: Sequelize;
  const seededIds: string[] = [];

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
  });

  afterAll(async () => {
    if (seededIds.length > 0) {
      await sequelize.query('DELETE FROM promo_code.grpc_service_identity WHERE id IN (:ids)', {
        type: QueryTypes.RAW,
        replacements: { ids: seededIds },
      });
    }
    await sequelize.close();
  });

  // TC-1/TC-2: table exists, with the schema's other tables unaffected (TC-4, adjacent
  // behaviour — the count includes the 5 pre-existing tables plus this one, never fewer).
  it('TC-1/TC-2: promo_code.grpc_service_identity exists alongside the 5 T-PC-002 tables', async () => {
    // Selects a second column (`table_schema`) deliberately, not just `table_name` — same
    // driver quirk `migrations.spec.ts` TC-2 already documents: with the installed `pg` driver a
    // single-column SELECT comes back as `[[value], ...]` (array-of-arrays), not
    // `[{ table_name: value }, ...]`; a second, constant column sidesteps it.
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

  it('adjacent: a valid identity insert succeeds and defaults status to ACTIVE', async () => {
    const id = await insertIdentity(sequelize);
    seededIds.push(id);
    const [row] = await sequelize.query<{ status: string }>(
      'SELECT status FROM promo_code.grpc_service_identity WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    expect(row.status).toBe('ACTIVE');
  });

  // TC-3 — the regression test. Sequelize wraps a unique-violation into
  // `SequelizeUniqueConstraintError` with the real constraint name on `.parent.constraint`, same
  // shape T-PC-002's own TC-5/TC-7/TC-9 already document.
  it('TC-3: rejects a second row with the same service_identity (uc_gsi_identity)', async () => {
    const serviceIdentity = `t-pc-044-dup-${randomUUID()}`;
    const firstId = await insertIdentity(sequelize, { service_identity: serviceIdentity });
    seededIds.push(firstId);

    await expect(
      insertIdentity(sequelize, { service_identity: serviceIdentity }),
    ).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ constraint: 'uc_gsi_identity' }),
    });
  });

  it('rejects an empty/blank service_identity', async () => {
    await expect(insertIdentity(sequelize, { service_identity: '   ' })).rejects.toThrow(
      /grpc_service_identity/,
    );
  });

  it('rejects a status outside ACTIVE/REVOKED', async () => {
    await expect(
      sequelize.query(
        `INSERT INTO promo_code.grpc_service_identity
           (service_identity, status, created_by)
         VALUES (:service_identity, 'PENDING', :created_by)`,
        {
          type: QueryTypes.RAW,
          replacements: { service_identity: `t-pc-044-bad-${randomUUID()}`, created_by: ACTOR_ID },
        },
      ),
    ).rejects.toThrow(/grpc_service_identity/);
  });

  it('a REVOKED row can be re-flipped to ACTIVE without violating uc_gsi_identity', async () => {
    const id = await insertIdentity(sequelize);
    seededIds.push(id);
    await sequelize.query(
      "UPDATE promo_code.grpc_service_identity SET status = 'REVOKED' WHERE id = :id",
      { type: QueryTypes.RAW, replacements: { id } },
    );
    await expect(
      sequelize.query(
        "UPDATE promo_code.grpc_service_identity SET status = 'ACTIVE' WHERE id = :id",
        { type: QueryTypes.RAW, replacements: { id } },
      ),
    ).resolves.toBeDefined();
  });
});

describe('T-PC-044 — promo_code_app inherits 007’s default-privilege grant on the new table', () => {
  let sequelize: Sequelize;
  let appSequelize: Sequelize;
  let seededId: string;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    appSequelize = new Sequelize({
      dialect: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      username: process.env.DB_APP_USERNAME,
      password: process.env.DB_APP_PASSWORD,
      logging: false,
    });
    await sequelize.authenticate();
    await appSequelize.authenticate();
    seededId = await insertIdentity(sequelize);
  });

  afterAll(async () => {
    await sequelize.query('DELETE FROM promo_code.grpc_service_identity WHERE id = :id', {
      type: QueryTypes.RAW,
      replacements: { id: seededId },
    });
    await sequelize.close();
    await appSequelize.close();
  });

  it('promo_code_app can SELECT the new table without an explicit GRANT statement in 008', async () => {
    await expect(
      appSequelize.query('SELECT count(*) FROM promo_code.grpc_service_identity', {
        type: QueryTypes.SELECT,
      }),
    ).resolves.toBeDefined();
  });
});
