/**
 * T-042 — `/definition-requests` against the **real** Postgres instance, through the real
 * `AppModule`, over real HTTP, as every role. Follows `test/blasts/blasts.e2e-spec.ts` (T-041) /
 * `test/rules/rules.e2e-spec.ts` (T-031)'s harness.
 *
 * Verification steps 2-4 are evidenced as one continuous chain in "the full request → review →
 * approve → author → publish → fulfil → blast chain" below: a country admin submits, a super
 * admin reviews and approves, authors and publishes a rule version, fulfils the request with it,
 * and blasts it to the requesting country — `rule_versions.origin_request_id` and
 * `version_blasts.origin_request_id` are both read back from the live database, not asserted
 * from the response body alone.
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

const SUITE = 't042';
const PASSWORD = 'correct horse battery staple 7!';
const COUNTRY_A = 'D1';
const COUNTRY_B = 'D2';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let countryA: number;
let countryB: number;
let tenantA: number;
let merchantA: number;
let subCategoryId: number;
const createdRuleIds = new Set<number>();
const createdRequestIds = new Set<number>();

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
    displayName: `T-042 ${key}`,
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

function patch(key: string, path: string, body: unknown = {}) {
  return http()
    .patch(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send(body as object);
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
    { tenantId: tenantIdValue, code, countryCode: COUNTRY_A },
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
  return `T042_${Date.now()}_${counter}_${suffix}`.slice(0, 80).toUpperCase();
}

function submitPayload(overrides: Record<string, unknown> = {}) {
  return {
    requestType: 'new_rule',
    title: 'Weekend multiplier',
    description: 'We need a weekend transaction multiplier rule for this country.',
    ...overrides,
  };
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

  countryA = await ensureCountry(COUNTRY_A, 'T-042 e2e A');
  countryB = await ensureCountry(COUNTRY_B, 'T-042 e2e B');
  tenantA = await ensureTenant('T042_TENANT_A', countryA);
  merchantA = await ensureMerchant('T042_MERCHANT_A', tenantA);
  subCategoryId = await ensureSubCategory();

  await makeActor('super', 'super_admin', { countryId: null, tenantId: null, merchantId: null });
  await makeActor('adminA', 'country_admin', {
    countryId: countryA,
    tenantId: null,
    merchantId: null,
  });
  await makeActor('adminB', 'country_admin', {
    countryId: countryB,
    tenantId: null,
    merchantId: null,
  });
  await makeActor('tenantA', 'tenant_admin', {
    countryId: countryA,
    tenantId: tenantA,
    merchantId: null,
  });
  await makeActor('makerA', 'maker', { countryId: countryA, tenantId: tenantA, merchantId: null });
  await makeActor('merchantA', 'merchant', {
    countryId: countryA,
    tenantId: tenantA,
    merchantId: merchantA,
  });
});

afterAll(async () => {
  if (db !== undefined) {
    if (createdRequestIds.size > 0) {
      await exec(`DELETE FROM reward_config.definition_requests WHERE id IN (:ids)`, {
        ids: [...createdRequestIds],
      });
    }
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
      // (superuser) connection can, matching T-005's own e2e-spec precedent
      // (`blasts.e2e-spec.ts`) — a published `rule_versions` row is undeletable by trigger
      // (T005_007), so it must be lifted temporarily to let this suite's own `rule_master`
      // fixtures (and everything that references them) be removed in `afterAll`.
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
      tenantId: tenantA,
    });

    for (const actor of actors.values()) {
      await exec('DELETE FROM reward_portal.portal_users WHERE id = :id', { id: actor.userId });
    }

    await removeEncryptionKeys(db, SUITE);
  }
  if (app !== undefined) await app.close();
});

describe('T-042 — POST /definition-requests — TC-1…TC-5, TC-20', () => {
  it('TC-4: maker → 403', async () => {
    const response = await post('makerA', '/definition-requests', submitPayload());
    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'PERM_DENIED');
  });

  it('TC-5: merchant → 403', async () => {
    const response = await post('merchantA', '/definition-requests', submitPayload());
    expect(response.status).toBe(403);
  });

  it("TC-1/TC-2: country_admin submits — 201, submitted, scope is the actor's own country (any body-supplied scope field is rejected by the whitelist, R3)", async () => {
    const response = await post('adminA', '/definition-requests', {
      ...submitPayload(),
      // A malicious/naive client trying to move scope by supplying it directly — rejected before
      // it ever reaches the service (`ValidationPipe({ forbidNonWhitelisted: true })`,
      // `CreateDefinitionRequestDto` has no such field to accept it).
      requestingCountryId: countryB,
    });
    expect(response.status).toBe(400);
  });

  it('TC-1: country_admin submits a well-formed request — 201, submitted', async () => {
    const response = await post('adminA', '/definition-requests', submitPayload());
    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('submitted');
    expect(response.body.data.requestingCountryId).toBe(countryA);
    expect(response.body.data.requestingTenantId).toBeNull();
    createdRequestIds.add(response.body.data.id as number);
  });

  it('TC-3: tenant_admin submits — 201, tenant scope set', async () => {
    const response = await post(
      'tenantA',
      '/definition-requests',
      submitPayload({ requestType: 'new_reward', title: 'A new cashback reward' }),
    );
    expect(response.status).toBe(201);
    expect(response.body.data.requestingTenantId).toBe(tenantA);
    expect(response.body.data.requestingCountryId).toBeNull();
    createdRequestIds.add(response.body.data.id as number);
  });

  it('update_rule with no entityId — 400', async () => {
    const response = await post(
      'adminA',
      '/definition-requests',
      submitPayload({ requestType: 'update_rule' }),
    );
    expect(response.status).toBe(400);
  });
});

describe('T-042 — PATCH/withdraw — TC-6…TC-8', () => {
  it('TC-6/TC-7/TC-8: edit while submitted (200), edit after moving to under_review (409), then a fresh one is withdrawn while submitted (200)', async () => {
    const submitted = await post('adminA', '/definition-requests', submitPayload());
    const id = submitted.body.data.id as number;
    createdRequestIds.add(id);

    const edited = await patch('adminA', `/definition-requests/${String(id)}`, {
      title: 'Weekend multiplier (revised)',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.title).toBe('Weekend multiplier (revised)');

    const reviewed = await post('super', `/definition-requests/${String(id)}/review`, {
      status: 'under_review',
    });
    expect(reviewed.status).toBe(201);

    const blockedEdit = await patch('adminA', `/definition-requests/${String(id)}`, {
      title: 'Too late',
    });
    expect(blockedEdit.status).toBe(409);

    const another = await post('adminA', '/definition-requests', submitPayload());
    const anotherId = another.body.data.id as number;
    createdRequestIds.add(anotherId);
    const withdrawn = await post('adminA', `/definition-requests/${String(anotherId)}/withdraw`);
    expect(withdrawn.status).toBe(201);
    expect(withdrawn.body.data.status).toBe('withdrawn');
  });
});

describe('T-042 — POST .../review — TC-9…TC-12', () => {
  it('TC-10: reject without a comment — 400 (verification step 6)', async () => {
    const submitted = await post('adminA', '/definition-requests', submitPayload());
    const id = submitted.body.data.id as number;
    createdRequestIds.add(id);
    await post('super', `/definition-requests/${String(id)}/review`, { status: 'under_review' });

    const response = await post('super', `/definition-requests/${String(id)}/review`, {
      status: 'rejected',
    });
    expect(response.status).toBe(400);
  });

  it('TC-11: reject with a comment — 200, comment stored', async () => {
    const submitted = await post('adminA', '/definition-requests', submitPayload());
    const id = submitted.body.data.id as number;
    createdRequestIds.add(id);
    await post('super', `/definition-requests/${String(id)}/review`, { status: 'under_review' });

    const response = await post('super', `/definition-requests/${String(id)}/review`, {
      status: 'rejected',
      reviewComment: 'Not enough detail — please add expected volume.',
    });
    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('rejected');
    expect(response.body.data.reviewComment).toBe(
      'Not enough detail — please add expected volume.',
    );
  });

  it('TC-12: submitted → fulfilled directly (skipping review/approve) → 409', async () => {
    const submitted = await post('adminA', '/definition-requests', submitPayload());
    const id = submitted.body.data.id as number;
    createdRequestIds.add(id);

    const response = await post('super', `/definition-requests/${String(id)}/fulfil`, {
      versionId: 1,
    });
    expect(response.status).toBe(409);
  });

  it('a role outside super_admin cannot review — 403', async () => {
    const submitted = await post('adminA', '/definition-requests', submitPayload());
    const id = submitted.body.data.id as number;
    createdRequestIds.add(id);

    const response = await post('adminA', `/definition-requests/${String(id)}/review`, {
      status: 'under_review',
    });
    expect(response.status).toBe(403);
  });
});

describe('T-042 — GET /definition-requests — TC-15…TC-17, TC-21', () => {
  it("TC-15: country B admin reading country A's request → 404", async () => {
    const submitted = await post('adminA', '/definition-requests', submitPayload());
    const id = submitted.body.data.id as number;
    createdRequestIds.add(id);

    const response = await get('adminB', `/definition-requests/${String(id)}`);
    expect(response.status).toBe(404);
  });

  it('TC-16/TC-17: super_admin sees requests from multiple countries; country_admin sees only their own', async () => {
    const fromA = await post('adminA', '/definition-requests', submitPayload());
    createdRequestIds.add(fromA.body.data.id as number);

    const superList = await get('super', '/definition-requests?pageSize=100');
    expect(superList.status).toBe(200);
    const superIds = (superList.body.data as { id: number }[]).map((row) => row.id);
    expect(superIds).toContain(fromA.body.data.id);

    const adminAList = await get('adminA', '/definition-requests?pageSize=100');
    expect(adminAList.status).toBe(200);
    const adminAIds = (adminAList.body.data as { id: number }[]).map((row) => row.id);
    expect(adminAIds).toContain(fromA.body.data.id);

    const adminBList = await get('adminB', '/definition-requests?pageSize=100');
    expect(adminBList.status).toBe(200);
    const adminBIds = (adminBList.body.data as { id: number }[]).map((row) => row.id);
    expect(adminBIds).not.toContain(fromA.body.data.id);
  });

  it('TC-21: filterable by status and priority', async () => {
    const response = await get(
      'super',
      '/definition-requests?status=submitted&priority=normal&pageSize=100',
    );
    expect(response.status).toBe(200);
    for (const row of response.body.data as { status: string; priority: string }[]) {
      expect(row.status).toBe('submitted');
      expect(row.priority).toBe('normal');
    }
  });
});

describe(
  'T-042 — the full chain: submit → review → approve → author → publish → fulfil → blast ' +
    '(verification steps 2-4, TC-13, TC-18, TC-19)',
  () => {
    it('links a request to a rule version and a blast, traceable in both directions', async () => {
      const submitted = await post('adminA', '/definition-requests', submitPayload());
      expect(submitted.status).toBe(201);
      const requestId = submitted.body.data.id as number;
      createdRequestIds.add(requestId);

      const underReview = await post('super', `/definition-requests/${String(requestId)}/review`, {
        status: 'under_review',
      });
      expect(underReview.status).toBe(201);

      const approved = await post('super', `/definition-requests/${String(requestId)}/review`, {
        status: 'approved',
      });
      expect(approved.status).toBe(201);
      expect(approved.body.data.status).toBe('approved');

      // Author v1 — a rule, then a draft version linking back to the request
      // (`createVersionRequestSchema.originRequestId`, T-041's own contract).
      const rule = await post('super', '/rules', {
        ruleCode: code('R'),
        name: 'T-042 e2e weekend multiplier',
        subCategoryId,
        expression: 'amount >= :minSpend',
        parameters: { fields: [{ key: 'minSpend', label: 'Min', type: 'number', required: true }] },
      });
      expect(rule.status).toBe(201);
      const ruleId = rule.body.data.id as number;
      createdRuleIds.add(ruleId);

      const draft = await post('super', `/rules/${String(ruleId)}/versions`, {
        originRequestId: requestId,
      });
      expect(draft.status).toBe(201);
      const versionId = draft.body.data.id as number;

      // TC-14: fulfilling with the still-draft version → 422.
      const draftFulfil = await post('super', `/definition-requests/${String(requestId)}/fulfil`, {
        versionId,
      });
      expect(draftFulfil.status).toBe(422);

      const published = await post(
        'super',
        `/rules/${String(ruleId)}/versions/${String(versionId)}/publish`,
      );
      expect(published.status).toBe(201);

      // TC-13: fulfil with the now-published version — 200, fulfilledVersionId set.
      const fulfilled = await post('super', `/definition-requests/${String(requestId)}/fulfil`, {
        versionId,
      });
      expect(fulfilled.status).toBe(201);
      expect(fulfilled.body.data.status).toBe('fulfilled');
      expect(fulfilled.body.data.fulfilledVersionId).toBe(versionId);

      // Verification step 3, literal SQL — the version carries origin_request_id.
      const [versionRow] = await sql<{ origin_request_id: number }>(
        'SELECT origin_request_id FROM reward_config.rule_versions WHERE id = :versionId',
        { versionId },
      );
      expect(versionRow.origin_request_id).toBe(requestId);

      // Verification step 4 — blast v1 to the requesting country, origin_request_id populated.
      const blast = await post('super', '/blasts', {
        entityType: 'rule',
        entityId: ruleId,
        versionId,
        scope: 'selected',
        countryIds: [countryA],
        originRequestId: requestId,
      });
      expect(blast.status).toBe(201);

      const [blastRow] = await sql<{ origin_request_id: number }>(
        'SELECT origin_request_id FROM reward_config.version_blasts WHERE id = :id',
        { id: blast.body.data.id },
      );
      expect(blastRow.origin_request_id).toBe(requestId);
    });
  },
);
