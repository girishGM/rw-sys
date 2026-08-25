/**
 * T-041 — `/blasts` against the **real** Postgres instance, through the real `AppModule`, over
 * real HTTP, as every role. Follows `test/rules/rules.e2e-spec.ts` (T-031) /
 * `test/rules/campaign-usage.e2e-spec.ts`'s harness.
 *
 * TC-10/TC-11 together are "the requirement, verbatim" (the task file's own words) and are
 * evidenced here for real: after a v2 blast, a country's v1 `rule_version_country_assignments`
 * row is `superseded`, **not removed**, and a campaign hand-built through the same real
 * `tracker_component_rules` chain `campaign-usage.e2e-spec.ts` uses (T-037 has not shipped, so
 * nothing else can produce these rows yet) stays pinned to v1 — proving a blast never rewrites
 * a running campaign's binding. Verification steps 3, 4, 6 and 7 are all evidenced literally,
 * not simulated.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { createMigrationConnection } from '@/database/migration-connection';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import type { PortalRole } from '@/database/portal-models';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import { expectErrorEnvelope } from '../common/support/error-envelope';

jest.setTimeout(300_000);

const SUITE = 't041b';
const PASSWORD = 'correct horse battery staple 7!';
const COUNTRY_MY = 'B1';
const COUNTRY_SG = 'B2';
/** `countries.code` is `char(2)` — a real ISO 3166-1 alpha-2 code is always purely alphabetic,
 * so a letter+digit pair can never collide with one. Four letters × ten digits = 40 codes,
 * exactly TC-27's country count.
 *
 * `H`/`J`/`K`/`L` — not `Q`/`R`/`S`/`T` as originally written — because `R1`-`R4` and `T5` are
 * already live, persistent fixture codes owned by `test/rules/rules.e2e-spec.ts` (T-031) and
 * `test/trace/trace.e2e-spec.ts` (T-045) respectively (`ensureCountry` upserts by code, so this
 * suite silently adopted — and then, in `afterAll`, tried to delete — another suite's country
 * row instead of creating its own, which fails on that row's own foreign keys and takes down
 * this entire file with "Test suite failed to run"). Confirmed against the live database, not
 * assumed: no `[HJKL][0-9]` code exists anywhere in `reward_config.countries` today. See this
 * task's completion report for the full trace.
 */
const PERF_COUNTRY_LETTERS = ['H', 'J', 'K', 'L'];
function perfCountryCode(index: number): string {
  const letter = PERF_COUNTRY_LETTERS[Math.floor(index / 10)];
  return `${letter}${String(index % 10)}`;
}

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let countryMY: number;
let countrySG: number;
let tenantMY: number;
let merchantMY: number;
let subCategoryId: number;
const createdRuleIds = new Set<number>();
const perfCountryIds: number[] = [];

interface Actor {
  readonly key: string;
  readonly email: string;
  readonly userId: number;
  readonly jar: string;
  readonly csrf: string;
}
const actors = new Map<string, Actor>();

function http() {
  return request(app.getHttpServer());
}

async function sql<T extends object>(
  statement: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return db.query<T>(statement, { type: QueryTypes.SELECT, replacements });
}

async function exec(statement: string, replacements: Record<string, unknown> = {}): Promise<void> {
  await db.query(statement, { type: QueryTypes.RAW, replacements });
}

function cookieValue(response: request.Response, name: string): string {
  const header = response.headers['set-cookie'];
  const entries = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const match = entries.find((entry) => entry.startsWith(`${name}=`));
  if (match === undefined) throw new Error(`no Set-Cookie for ${name}`);
  return decodeURIComponent(match.split(';')[0].slice(name.length + 1));
}

function jarFrom(response: request.Response): string {
  const header = response.headers['set-cookie'];
  const entries = Array.isArray(header) ? header : header === undefined ? [] : [header];
  return entries
    .map((entry) => entry.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

async function makeActor(
  key: string,
  role: PortalRole,
  scope: { countryId: number | null; tenantId: number | null; merchantId: number | null },
): Promise<Actor> {
  const email = `${SUITE}-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-041 ${key}`,
    role,
    ...scope,
    mustChangePassword: false,
  });

  await exec(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
  );

  const response = await loginCompletingMfa(app, { email, password: PASSWORD }, db);
  if (response.status !== 200) {
    throw new Error(`login for ${key} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  const actor: Actor = {
    key,
    email,
    userId,
    jar: jarFrom(response),
    csrf: cookieValue(response, CSRF_COOKIE_NAME),
  };
  actors.set(key, actor);
  return actor;
}

function as(key: string): Actor {
  const actor = actors.get(key);
  if (actor === undefined) throw new Error(`no actor "${key}"`);
  return actor;
}

function get(key: string, path: string) {
  return http().get(`/api/v1${path}`).set('Cookie', as(key).jar);
}

function post(key: string, path: string, body: unknown = {}) {
  return http()
    .post(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send(body as object);
}

function del(key: string, path: string) {
  return http()
    .delete(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf);
}

async function ensureCountry(code: string, name: string): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries WHERE code = :code',
    { code },
  );
  if (existing !== undefined) {
    await exec(`UPDATE reward_config.countries SET status = 'active' WHERE id = :id`, {
      id: existing.id,
    });
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
     VALUES (:code, :name, 'UTC', 'USD', '+001', 'active') RETURNING id`,
    { code, name },
  );
  return created.id;
}

async function ensureTenant(code: string, countryIdValue: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.tenants WHERE code = :code',
    { code },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.tenants SET status = 'active', deleted_at = NULL, country_id = :countryId WHERE id = :id`,
      { id: existing.id, countryId: countryIdValue },
    );
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active') RETURNING id`,
    { code, countryId: countryIdValue },
  );
  return created.id;
}

async function ensureMerchant(code: string, tenantIdValue: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.merchants WHERE merchant_code = :code',
    { code },
  );
  if (existing !== undefined) return existing.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.merchants (tenant_id, merchant_code, name, country_code, status)
     VALUES (:tenantId, :code, :code, :countryCode, 'active') RETURNING id`,
    { tenantId: tenantIdValue, code, countryCode: COUNTRY_MY },
  );
  return created.id;
}

async function ensureSubCategory(): Promise<number> {
  const [row] = await sql<{ id: number }>(
    `SELECT rsc.id
       FROM reward_config.rule_sub_categories rsc
       JOIN reward_config.rule_categories rc ON rc.id = rsc.category_id
      WHERE rc.category_code = 'TRANSACTION' AND rsc.sub_category_code = 'GENERAL'
      LIMIT 1`,
  );
  if (row === undefined)
    throw new Error('seeded rule_sub_categories row not found — is T-004 applied?');
  return row.id;
}

let counter = 0;
function code(suffix: string): string {
  counter += 1;
  return `T041B_${Date.now()}_${counter}_${suffix}`.slice(0, 80).toUpperCase();
}

async function createPublishedRuleVersion(): Promise<{
  ruleId: number;
  versionId: number;
  versionNo: number;
}> {
  const created = await post('super', '/rules', {
    ruleCode: code('R'),
    name: 'T-041 blast e2e rule',
    subCategoryId,
    expression: 'amount >= :minSpend',
    parameters: { fields: [{ key: 'minSpend', label: 'Min', type: 'number', required: true }] },
  });
  expect(created.status).toBe(201);
  const ruleId = created.body.data.id as number;
  createdRuleIds.add(ruleId);

  const draft = await post('super', `/rules/${String(ruleId)}/versions`, {});
  const versionId = draft.body.data.id as number;
  const published = await post(
    'super',
    `/rules/${String(ruleId)}/versions/${String(versionId)}/publish`,
  );
  return { ruleId, versionId, versionNo: published.body.data.versionNo as number };
}

async function nextDraftAndPublish(
  ruleId: number,
): Promise<{ versionId: number; versionNo: number }> {
  const draft = await post('super', `/rules/${String(ruleId)}/versions`, {});
  const versionId = draft.body.data.id as number;
  const published = await post(
    'super',
    `/rules/${String(ruleId)}/versions/${String(versionId)}/publish`,
  );
  return { versionId, versionNo: published.body.data.versionNo as number };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), SUITE);

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  await app.listen(0);

  db = app.get<Sequelize>(SEQUELIZE);
  emailCrypto = emailCryptoOf(app);

  countryMY = await ensureCountry(COUNTRY_MY, 'T-041 blast e2e MY');
  countrySG = await ensureCountry(COUNTRY_SG, 'T-041 blast e2e SG');
  tenantMY = await ensureTenant('T041B_TENANT_MY', countryMY);
  merchantMY = await ensureMerchant('T041B_MERCHANT_MY', tenantMY);
  subCategoryId = await ensureSubCategory();

  await makeActor('super', 'super_admin', { countryId: null, tenantId: null, merchantId: null });
  await makeActor('adminMY', 'country_admin', {
    countryId: countryMY,
    tenantId: null,
    merchantId: null,
  });
  await makeActor('adminSG', 'country_admin', {
    countryId: countrySG,
    tenantId: null,
    merchantId: null,
  });
  await makeActor('tenantMY', 'tenant_admin', {
    countryId: countryMY,
    tenantId: tenantMY,
    merchantId: null,
  });
  await makeActor('makerMY', 'maker', {
    countryId: countryMY,
    tenantId: tenantMY,
    merchantId: null,
  });
  await makeActor('checkerMY', 'checker', {
    countryId: countryMY,
    tenantId: tenantMY,
    merchantId: null,
  });
  await makeActor('merchantMY', 'merchant', {
    countryId: countryMY,
    tenantId: tenantMY,
    merchantId: merchantMY,
  });
});

afterAll(async () => {
  if (db !== undefined) {
    await exec(`DELETE FROM reward_config.tracker_component_rules WHERE tenant_id = :tenantId`, {
      tenantId: tenantMY,
    });
    await exec(`DELETE FROM reward_config.tenant_campaign_trackers WHERE tenant_id = :tenantId`, {
      tenantId: tenantMY,
    });
    await exec(`DELETE FROM reward_config.tenant_campaigns WHERE tenant_id = :tenantId`, {
      tenantId: tenantMY,
    });
    await exec(
      `DELETE FROM reward_config.tracker_tracker_components WHERE tracker_id IN
        (SELECT id FROM reward_config.trackers WHERE tenant_id = :tenantId)`,
      { tenantId: tenantMY },
    );
    await exec(`DELETE FROM reward_config.trackers WHERE tenant_id = :tenantId`, {
      tenantId: tenantMY,
    });
    await exec(`DELETE FROM reward_config.tracker_components WHERE tenant_id = :tenantId`, {
      tenantId: tenantMY,
    });

    if (createdRuleIds.size > 0) {
      await exec(
        `DELETE FROM reward_config.rule_version_country_assignments WHERE rule_id IN (:ids)`,
        { ids: [...createdRuleIds] },
      );
      await exec(
        `DELETE FROM reward_config.version_blast_targets WHERE blast_id IN (
           SELECT id FROM reward_config.version_blasts WHERE entity_type = 'rule' AND entity_id IN (:ids)
         )`,
        { ids: [...createdRuleIds] },
      );
      await exec(
        `DELETE FROM reward_config.version_blasts WHERE entity_type = 'rule' AND entity_id IN (:ids)`,
        { ids: [...createdRuleIds] },
      );
      await exec(`DELETE FROM reward_config.rule_country_assignments WHERE rule_id IN (:ids)`, {
        ids: [...createdRuleIds],
      });
      // reward_app lacks DDL privilege to disable/enable triggers; only the migration
      // (superuser) connection can, matching T-005's own e2e-spec precedent.
      const migration = createMigrationConnection();
      await migration.authenticate();
      await migration.query(
        `ALTER TABLE reward_config.rule_versions DISABLE TRIGGER trg_rule_versions_undeletable`,
        { type: QueryTypes.RAW },
      );
      await exec(`DELETE FROM reward_config.rule_versions WHERE rule_id IN (:ids)`, {
        ids: [...createdRuleIds],
      });
      await migration.query(
        `ALTER TABLE reward_config.rule_versions ENABLE TRIGGER trg_rule_versions_undeletable`,
        { type: QueryTypes.RAW },
      );
      await migration.close();
      await exec(`DELETE FROM reward_config.rule_master WHERE id IN (:ids)`, {
        ids: [...createdRuleIds],
      });
    }

    await exec(`DELETE FROM reward_portal.portal_user_notifications WHERE tenant_id = :tenantId`, {
      tenantId: tenantMY,
    });

    for (const actor of actors.values()) {
      await exec('DELETE FROM reward_portal.portal_users WHERE id = :id', { id: actor.userId });
    }

    if (perfCountryIds.length > 0) {
      await exec(
        `DELETE FROM reward_config.rule_version_country_assignments WHERE country_id IN (:ids)`,
        { ids: perfCountryIds },
      );
      await exec(`DELETE FROM reward_config.version_blast_targets WHERE country_id IN (:ids)`, {
        ids: perfCountryIds,
      });
      await exec(`DELETE FROM reward_config.rule_country_assignments WHERE country_id IN (:ids)`, {
        ids: perfCountryIds,
      });
      await exec(`DELETE FROM reward_config.countries WHERE id IN (:ids)`, { ids: perfCountryIds });
    }

    await removeEncryptionKeys(db, SUITE);
  }
  if (app !== undefined) await app.close();
});

describe('T-041 — POST /blasts/preview — TC-19/TC-20', () => {
  it('TC-19: writes nothing — row counts across all four tables are unchanged (verification step 7)', async () => {
    const { ruleId, versionId } = await createPublishedRuleVersion();

    const before = await Promise.all([
      sql<{ n: string }>('SELECT count(*)::text AS n FROM reward_config.version_blasts'),
      sql<{ n: string }>('SELECT count(*)::text AS n FROM reward_config.version_blast_targets'),
      sql<{ n: string }>(
        'SELECT count(*)::text AS n FROM reward_config.rule_version_country_assignments',
      ),
      sql<{ n: string }>('SELECT count(*)::text AS n FROM reward_config.rule_country_assignments'),
    ]);

    const preview = await post('super', '/blasts/preview', {
      entityType: 'rule',
      entityId: ruleId,
      versionId,
      scope: 'selected',
      countryIds: [countryMY, countrySG],
    });
    expect(preview.status).toBe(201);
    expect(preview.body.data.countries).toHaveLength(2);
    expect(preview.body.data.countries[0].currentVersionNo).toBeNull();

    const after = await Promise.all([
      sql<{ n: string }>('SELECT count(*)::text AS n FROM reward_config.version_blasts'),
      sql<{ n: string }>('SELECT count(*)::text AS n FROM reward_config.version_blast_targets'),
      sql<{ n: string }>(
        'SELECT count(*)::text AS n FROM reward_config.rule_version_country_assignments',
      ),
      sql<{ n: string }>('SELECT count(*)::text AS n FROM reward_config.rule_country_assignments'),
    ]);

    expect(after.map((r) => r[0].n)).toEqual(before.map((r) => r[0].n));
  });
});

describe('T-041 — POST /blasts — TC-7…TC-18', () => {
  it('TC-16: country_admin calls POST /blasts → 403 (verification step 6)', async () => {
    const { ruleId, versionId } = await createPublishedRuleVersion();
    const response = await post('adminMY', '/blasts', {
      entityType: 'rule',
      entityId: ruleId,
      versionId,
      scope: 'selected',
      countryIds: [countryMY],
    });
    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'PERM_DENIED');
  });

  it('TC-17: tenant_admin/maker/checker/merchant → 403 each', async () => {
    const { ruleId, versionId } = await createPublishedRuleVersion();
    for (const key of ['tenantMY', 'makerMY', 'checkerMY', 'merchantMY']) {
      const response = await post(key, '/blasts', {
        entityType: 'rule',
        entityId: ruleId,
        versionId,
        scope: 'selected',
        countryIds: [countryMY],
      });
      expect(response.status).toBe(403);
    }
  });

  it('TC-14: blasting a draft version → 422', async () => {
    const created = await post('super', '/rules', {
      ruleCode: code('D'),
      name: 'draft-only rule',
      subCategoryId,
    });
    createdRuleIds.add(created.body.data.id as number);
    const draft = await post('super', `/rules/${String(created.body.data.id)}/versions`, {});

    const response = await post('super', '/blasts', {
      entityType: 'rule',
      entityId: created.body.data.id,
      versionId: draft.body.data.id,
      scope: 'selected',
      countryIds: [countryMY],
    });
    expect(response.status).toBe(422);
    expectErrorEnvelope(response.body, 'BLAST_VERSION_NOT_PUBLISHED');
  });

  it('TC-15: a failure mid-transaction leaves no partial state — no blast row, no targets, no assignments', async () => {
    const { ruleId, versionId } = await createPublishedRuleVersion();

    // A real, temporary trigger — not a simulated one — that raises on the *second* country in
    // the loop (`countrySG`), forcing `BlastsService.create`'s per-country loop to fail partway
    // through, after `countryMY`'s own `version_blast_targets`/`rule_version_country_assignments`
    // /`rule_country_assignments` rows have already been written to the transaction. Only a real
    // Postgres rollback — not a unit-test double whose fake `sequelize.transaction()` always
    // "commits" (this file's own header) — can prove those writes never survive.
    const migration = createMigrationConnection();
    await migration.authenticate();
    await migration.query(
      `CREATE OR REPLACE FUNCTION reward_config.t041b_fail_on_country()
         RETURNS trigger AS $$
       BEGIN
         IF NEW.country_id = ${String(countrySG)} THEN
           RAISE EXCEPTION 'T-041 TC-15: injected failure for country %', NEW.country_id;
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql;`,
      { type: QueryTypes.RAW },
    );
    await migration.query(
      `CREATE TRIGGER t041b_fail_on_country
         BEFORE INSERT ON reward_config.version_blast_targets
         FOR EACH ROW EXECUTE FUNCTION reward_config.t041b_fail_on_country();`,
      { type: QueryTypes.RAW },
    );

    try {
      const [blastsBefore, targetsBefore, assignmentsBefore, legacyBefore] = await Promise.all([
        sql<{ n: string }>('SELECT count(*)::text AS n FROM reward_config.version_blasts'),
        sql<{ n: string }>('SELECT count(*)::text AS n FROM reward_config.version_blast_targets'),
        sql<{ n: string }>(
          'SELECT count(*)::text AS n FROM reward_config.rule_version_country_assignments',
        ),
        sql<{ n: string }>(
          'SELECT count(*)::text AS n FROM reward_config.rule_country_assignments',
        ),
      ]);

      const response = await post('super', '/blasts', {
        entityType: 'rule',
        entityId: ruleId,
        versionId,
        scope: 'selected',
        // MY first, SG second — the injected trigger fires on SG, after MY's rows are already
        // written inside the same, still-open transaction.
        countryIds: [countryMY, countrySG],
      });
      expect(response.status).toBeGreaterThanOrEqual(400);

      const [blastsAfter, targetsAfter, assignmentsAfter, legacyAfter] = await Promise.all([
        sql<{ n: string }>('SELECT count(*)::text AS n FROM reward_config.version_blasts'),
        sql<{ n: string }>('SELECT count(*)::text AS n FROM reward_config.version_blast_targets'),
        sql<{ n: string }>(
          'SELECT count(*)::text AS n FROM reward_config.rule_version_country_assignments',
        ),
        sql<{ n: string }>(
          'SELECT count(*)::text AS n FROM reward_config.rule_country_assignments',
        ),
      ]);

      // Nothing survived — not even MY's own rows, written and then rolled back with everything
      // else in the same transaction. This is the requirement, verbatim (TC-15).
      expect(blastsAfter[0].n).toBe(blastsBefore[0].n);
      expect(targetsAfter[0].n).toBe(targetsBefore[0].n);
      expect(assignmentsAfter[0].n).toBe(assignmentsBefore[0].n);
      expect(legacyAfter[0].n).toBe(legacyBefore[0].n);
    } finally {
      await migration.query(
        `DROP TRIGGER IF EXISTS t041b_fail_on_country ON reward_config.version_blast_targets;`,
        { type: QueryTypes.RAW },
      );
      await migration.query(`DROP FUNCTION IF EXISTS reward_config.t041b_fail_on_country();`, {
        type: QueryTypes.RAW,
      });
      await migration.close();
    }
  });

  it('TC-7/TC-9: blasts v1 to MY — 1 blast row, 1 target, 1 assignment, legacy row upserted', async () => {
    const { ruleId, versionId, versionNo } = await createPublishedRuleVersion();

    const response = await post('super', '/blasts', {
      entityType: 'rule',
      entityId: ruleId,
      versionId,
      scope: 'selected',
      countryIds: [countryMY],
      note: 'v1 to MY',
    });
    expect(response.status).toBe(201);
    expect(response.body.data.targetCount).toBe(1);
    expect(response.body.data.targets).toHaveLength(1);
    expect(response.body.data.targets[0].countryId).toBe(countryMY);

    const [assignment] = await sql<{ status: string; version_no: number }>(
      `SELECT rvca.status, rv.version_no
         FROM reward_config.rule_version_country_assignments rvca
         JOIN reward_config.rule_versions rv ON rv.id = rvca.rule_version_id
        WHERE rvca.rule_id = :ruleId AND rvca.country_id = :countryId`,
      { ruleId, countryId: countryMY },
    );
    expect(assignment).toMatchObject({ status: 'active', version_no: versionNo });

    // TC-9 — the legacy dual-write.
    const [legacy] = await sql<{ id: number }>(
      `SELECT id FROM reward_config.rule_country_assignments WHERE rule_id = :ruleId AND country_id = :countryId`,
      { ruleId, countryId: countryMY },
    );
    expect(legacy).toBeDefined();

    // TC-28 — audit.
    const [audit] = await sql<{ event_type: string }>(
      `SELECT event_type FROM reward_portal.portal_audit_log
        WHERE event_type = 'version_blasted' AND target_id = :id
        ORDER BY occurred_at DESC LIMIT 1`,
      { id: String(response.body.data.id) },
    );
    expect(audit).toBeDefined();
  });

  it('TC-8: blast to all_countries reaches MY and SG (among every other active country)', async () => {
    const { ruleId, versionId } = await createPublishedRuleVersion();
    const response = await post('super', '/blasts', {
      entityType: 'rule',
      entityId: ruleId,
      versionId,
      scope: 'all_countries',
    });
    expect(response.status).toBe(201);
    expect(response.body.data.scope).toBe('all_countries');
    const targetCountryIds = (response.body.data.targets as { countryId: number }[]).map(
      (t) => t.countryId,
    );
    expect(targetCountryIds).toEqual(expect.arrayContaining([countryMY, countrySG]));
  });

  it(
    'TC-10/TC-11/TC-12/TC-13: v2 blasted after v1 — MY holds both rows (v1 superseded, v2 ' +
      'active), a campaign already pinned to v1 keeps running v1 unchanged, and GET ' +
      '/countries/:id/assigned-versions — the endpoint a new campaign wizard would call to ' +
      'decide what to default-offer, per 06-VERSIONING.md §§6-7 — shows v2 as `active` (what a ' +
      'brand-new campaign is offered by default, TC-12) with v1 still present as `superseded` ' +
      '(what a maker may still explicitly select for an existing binding, TC-13) rather than ' +
      'removed (verification steps 3 and 4)',
    async () => {
      const { ruleId, versionId: v1Id, versionNo: v1No } = await createPublishedRuleVersion();

      const first = await post('super', '/blasts', {
        entityType: 'rule',
        entityId: ruleId,
        versionId: v1Id,
        scope: 'selected',
        countryIds: [countryMY],
      });
      expect(first.status).toBe(201);

      // Build the real tracker/component/campaign chain (T-037 has not shipped — this is the
      // same hand-built chain `campaign-usage.e2e-spec.ts` uses) and pin it to v1, the way
      // `tracker_component_rules.rule_version_id` records a binding at bind time
      // (06-VERSIONING.md §7).
      const [component] = await sql<{ id: number }>(
        `INSERT INTO reward_config.tracker_components (tenant_id, component_code, name, status)
         VALUES (:tenantId, :code, 'T-041 e2e component', 'active') RETURNING id`,
        { tenantId: tenantMY, code: code('COMP') },
      );
      const [tracker] = await sql<{ id: number }>(
        `INSERT INTO reward_config.trackers (tenant_id, tracker_code, name, status)
         VALUES (:tenantId, :code, 'T-041 e2e tracker', 'active') RETURNING id`,
        { tenantId: tenantMY, code: code('TRK') },
      );
      await exec(
        `INSERT INTO reward_config.tracker_tracker_components (tracker_id, component_id, sequence_order)
         VALUES (:trackerId, :componentId, 1)`,
        { trackerId: tracker.id, componentId: component.id },
      );
      const [campaign] = await sql<{ id: number }>(
        `INSERT INTO reward_config.tenant_campaigns
                (tenant_id, campaign_code, name, start_date, end_date, status, created_by)
         VALUES (:tenantId, :code, 'T-041 e2e pinned campaign',
                 now(), now() + interval '30 days', 'active', 'T041_e2e')
         RETURNING id`,
        { tenantId: tenantMY, code: code('CAMP') },
      );
      await exec(
        `INSERT INTO reward_config.tenant_campaign_trackers (tenant_id, campaign_id, tracker_id, status)
         VALUES (:tenantId, :campaignId, :trackerId, 'active')`,
        { tenantId: tenantMY, campaignId: campaign.id, trackerId: tracker.id },
      );
      await exec(
        `INSERT INTO reward_config.tracker_component_rules
                (tenant_id, tracker_component_id, rule_id, rule_version_id, status)
         VALUES (:tenantId, :componentId, :ruleId, :ruleVersionId, 'active')`,
        { tenantId: tenantMY, componentId: component.id, ruleId, ruleVersionId: v1Id },
      );

      const { versionId: v2Id, versionNo: v2No } = await nextDraftAndPublish(ruleId);
      const second = await post('super', '/blasts', {
        entityType: 'rule',
        entityId: ruleId,
        versionId: v2Id,
        scope: 'selected',
        countryIds: [countryMY],
      });
      expect(second.status).toBe(201);

      // Verification step 3, literal SQL: two rows, v1 superseded, v2 active — both present.
      const rows = await sql<{ version_no: number; status: string }>(
        `SELECT rv.version_no, rvca.status
           FROM reward_config.rule_version_country_assignments rvca
           JOIN reward_config.rule_versions rv ON rv.id = rvca.rule_version_id
          WHERE rvca.rule_id = :ruleId AND rvca.country_id = :countryId
          ORDER BY rv.version_no`,
        { ruleId, countryId: countryMY },
      );
      expect(rows).toEqual([
        { version_no: v1No, status: 'superseded' },
        { version_no: v2No, status: 'active' },
      ]);

      // TC-12/TC-13 — `GET /countries/:id/assigned-versions` (T-037 has not shipped, so this
      // read endpoint is the real, non-mocked mechanism a campaign wizard would call to decide
      // what to default-offer and what a maker may still pick; every sibling endpoint already
      // has real-Postgres e2e coverage, and this closes the one gap flagged on the prior
      // review). Called as `country_admin` (the endpoint's own second allowed role) against the
      // live blast state above, not a fixture.
      const assigned = await get('adminMY', `/countries/${String(countryMY)}/assigned-versions`);
      expect(assigned.status).toBe(200);
      const assignedForRule = (
        assigned.body.data as {
          entityType: string;
          entityId: number;
          versionNo: number;
          status: string;
        }[]
      ).filter((row) => row.entityType === 'rule' && row.entityId === ruleId);
      expect(assignedForRule).toEqual(
        expect.arrayContaining([
          // TC-12 — v2 is `active`: the version a brand-new campaign is offered by default.
          expect.objectContaining({ versionNo: v2No, status: 'active' }),
          // TC-13 — v1 is `superseded`, not absent: still returned, still selectable for an
          // existing/maker-chosen binding, matching TC-10/TC-11's own "still present" row above.
          expect.objectContaining({ versionNo: v1No, status: 'superseded' }),
        ]),
      );
      expect(assignedForRule).toHaveLength(2);

      // Verification step 4 — the pinned campaign is completely untouched by the v2 blast.
      const [pin] = await sql<{ rule_version_id: number }>(
        `SELECT rule_version_id FROM reward_config.tracker_component_rules WHERE rule_id = :ruleId`,
        { ruleId },
      );
      expect(pin.rule_version_id).toBe(v1Id);

      // TC-21 — withdrawing v1 from MY while that campaign is still bound → 422 listing it.
      const withdrawBlocked = await del(
        'super',
        `/rules/${String(ruleId)}/versions/${String(v1Id)}/countries/${String(countryMY)}`,
      );
      expect(withdrawBlocked.status).toBe(422);
      expectErrorEnvelope(withdrawBlocked.body, 'VERSION_HAS_CAMPAIGNS');
      expect(withdrawBlocked.body.error.details).toEqual([
        { field: 'campaignId', code: `CAMPAIGN_${String(campaign.id)}` },
      ]);
    },
  );

  it('TC-22: withdraws a version with no campaigns bound — 204', async () => {
    const { ruleId, versionId } = await createPublishedRuleVersion();
    await post('super', '/blasts', {
      entityType: 'rule',
      entityId: ruleId,
      versionId,
      scope: 'selected',
      countryIds: [countrySG],
    });

    const response = await del(
      'super',
      `/rules/${String(ruleId)}/versions/${String(versionId)}/countries/${String(countrySG)}`,
    );
    expect(response.status).toBe(204);

    const [row] = await sql<{ status: string }>(
      `SELECT status FROM reward_config.rule_version_country_assignments
        WHERE rule_version_id = :versionId AND country_id = :countryId`,
      { versionId, countryId: countrySG },
    );
    expect(row.status).toBe('withdrawn');
  });

  it('TC-18: country_admin GET /blasts sees only blasts targeting their own country', async () => {
    const { ruleId, versionId } = await createPublishedRuleVersion();
    const blast = await post('super', '/blasts', {
      entityType: 'rule',
      entityId: ruleId,
      versionId,
      scope: 'selected',
      countryIds: [countryMY],
    });
    const blastId = blast.body.data.id as number;

    const myView = await get('adminMY', '/blasts');
    expect(myView.status).toBe(200);
    const myIds = (myView.body.data as { id: number }[]).map((row) => row.id);
    expect(myIds).toContain(blastId);
    expect(
      (myView.body.data as { targets: { countryId: number }[] }[]).every((row) =>
        row.targets.every((target) => target.countryId === countryMY),
      ),
    ).toBe(true);

    const sgView = await get('adminSG', '/blasts');
    expect(sgView.status).toBe(200);
    const sgIds = (sgView.body.data as { id: number }[]).map((row) => row.id);
    expect(sgIds).not.toContain(blastId);
  });
});

describe('T-041 — TC-27: blast performance', () => {
  it('blasts to 40 countries in under 3 seconds, in one transaction', async () => {
    const { ruleId, versionId } = await createPublishedRuleVersion();

    for (let i = 0; i < 40; i += 1) {
      const id = await ensureCountry(perfCountryCode(i), `Perf ${String(i)}`);
      perfCountryIds.push(id);
    }

    const start = Date.now();
    const response = await post('super', '/blasts', {
      entityType: 'rule',
      entityId: ruleId,
      versionId,
      scope: 'selected',
      countryIds: perfCountryIds,
    });
    const elapsedMs = Date.now() - start;

    expect(response.status).toBe(201);
    expect(response.body.data.targetCount).toBe(40);
    expect(elapsedMs).toBeLessThan(3000);
  });
});
