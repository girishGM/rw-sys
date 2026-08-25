/**
 * T-067 — the regression test for the defect itself, against the real database and a real boot.
 *
 * This is the one test that would have caught the original bug. It reconstructs, exactly, the
 * state an interrupted test run leaves behind — an `encryption_keys` row naming an environment
 * variable that no longer exists anywhere — and then does the thing that used to fail: boots the
 * real `AppModule`, which runs `KeyRegistryService.onModuleInit()` against the real table.
 *
 * The unit specs in `orphaned-test-keys.spec.ts` prove the sweep's predicate is correct in
 * isolation. They cannot prove the defect is fixed, because the defect was never about the
 * predicate — it was about a durable row outliving ephemeral key material and taking the next
 * boot down with it. Only a real boot against a real table can show that, which is precisely the
 * lesson AGENT-PROTOCOL §3 draws from T-011/T-058: assert the outcome in the thing that actually
 * enforces the rule.
 *
 * Proven red before it was proven green — see the T-067 completion report, TC-3.
 */
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ensureEncryptionKeys, removeEncryptionKeys } from '../auth/support/portal-user-fixture';
import { sweepOrphanedTestKeys } from '../support/encryption-keys';

const SUITE = 't067';

/**
 * The orphans. `t067orphan_t056_fld` matches the `portal-user-fixture.ts` legacy namespace, and
 * its environment variable is never set by anything — which is the whole point: it stands in for
 * a variable that only ever existed inside a process that has since been killed.
 */
const ORPHANS = [
  { kid: 't067orphan_t056_fld', purpose: 'field', algorithm: 'AES-256-GCM' },
  { kid: 't067orphan_t056_bidx', purpose: 'blind_index', algorithm: 'HMAC-SHA256' },
] as const;

/** A kid outside the test namespace, used to prove the sweep leaves real keys alone. */
const FOREIGN_KID = 't067_not_test_owned';

let bootstrap: Sequelize;

function connect(): Sequelize {
  return new Sequelize({
    dialect: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    username: process.env.DB_APP_USERNAME,
    password: process.env.DB_APP_PASSWORD,
    logging: false,
  });
}

async function insertOrphans(): Promise<void> {
  for (const orphan of ORPHANS) {
    await bootstrap.query(
      `INSERT INTO reward_portal.encryption_keys (kid, purpose, algorithm, key_ref, status)
       VALUES (:kid, :purpose, :algorithm, :ref, 'rotating')`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          kid: orphan.kid,
          purpose: orphan.purpose,
          algorithm: orphan.algorithm,
          // Deliberately never placed in process.env — that is what makes it an orphan.
          ref: `env:${orphan.kid.toUpperCase()}_NEVER_SET`,
        },
      },
    );
  }
}

async function kidsPresent(): Promise<string[]> {
  const rows = await bootstrap.query<{ kid: string }>(
    `SELECT kid FROM reward_portal.encryption_keys ORDER BY kid`,
    { type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.kid);
}

async function deleteKids(kids: readonly string[]): Promise<void> {
  await bootstrap.query(`DELETE FROM reward_portal.encryption_keys WHERE kid IN (:kids)`, {
    type: QueryTypes.DELETE,
    replacements: { kids: [...kids] },
  });
}

beforeAll(async () => {
  bootstrap = connect();
  await bootstrap.authenticate();
});

afterAll(async () => {
  await deleteKids([...ORPHANS.map((o) => o.kid), FOREIGN_KID]);
  await removeEncryptionKeys(bootstrap, SUITE);
  await bootstrap.close();
});

describe('T-067 — orphaned encryption keys do not block boot', () => {
  beforeEach(async () => {
    await deleteKids([...ORPHANS.map((o) => o.kid), FOREIGN_KID]);
  });

  /**
   * TC-1 / TC-2. Before the fix this test fails at `app.init()` with
   * `KeyRegistryError: Environment variable 'T067ORPHAN_T056_FLD_NEVER_SET' … is not set`.
   */
  it('boots the real AppModule after an interrupted run left orphan rows', async () => {
    await insertOrphans();
    expect(await kidsPresent()).toEqual(expect.arrayContaining(ORPHANS.map((o) => o.kid)));

    // What every e2e suite does in its own beforeAll, and the point at which recovery happens.
    await ensureEncryptionKeys(bootstrap, SUITE);

    expect(await kidsPresent()).not.toEqual(expect.arrayContaining(ORPHANS.map((o) => o.kid)));

    let app: INestApplication | undefined;
    try {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      // The assertion: this line is what used to throw.
      await app.init();
      expect(app.get<Sequelize>(SEQUELIZE)).toBeDefined();
    } finally {
      await app?.close();
    }
  }, 60_000);

  /**
   * The safety half. An unresolvable row that the harness does *not* own is left in place, and
   * the boot still fails on it — a genuinely missing production key must never be swept away
   * to make a test go green.
   */
  it('leaves an unresolvable row outside the test namespace strictly alone', async () => {
    await bootstrap.query(
      `INSERT INTO reward_portal.encryption_keys (kid, purpose, algorithm, key_ref, status)
       VALUES (:kid, 'field', 'AES-256-GCM', 'env:T067_NOT_TEST_OWNED_NEVER_SET', 'rotating')`,
      { type: QueryTypes.INSERT, replacements: { kid: FOREIGN_KID } },
    );

    const removed = await sweepOrphanedTestKeys(bootstrap);

    expect(removed).not.toContain(FOREIGN_KID);
    expect(await kidsPresent()).toContain(FOREIGN_KID);
  });
});
