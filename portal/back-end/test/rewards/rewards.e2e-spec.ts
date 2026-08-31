/**
 * T-032 — `/rewards` against the **real** Postgres instance, through the real `AppModule`, over
 * real HTTP, as every role. Same harness `test/rules/rules.e2e-spec.ts` (T-031) establishes: real
 * login (through MFA for `super_admin`, T-055), real cookies, real guards, real
 * `ScopedRepository` scoping.
 *
 * TC-3/verification step 6 is deliberately performed for real here — a live `UPDATE
 * reward_config.role_entity_permissions` for `maker`/`reward`, restored in a `finally` block —
 * for the identical reason `rules.e2e-spec.ts`'s own header states, and against a row
 * (`role='maker', entity='reward'`) disjoint from every other suite that does this, so parallel
 * Jest workers cannot collide.
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
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import type { PortalRole } from '@/database/portal-models';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { redactSql } from '@/database/logging/redact-sql';
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

const T032_SUITE = 't032';
const PASSWORD = 'correct horse battery staple 7!';
const COUNTRY_A_CODE = 'W1';
const COUNTRY_B_CODE = 'W2';
const SYSTEM_CODE_PREFIX = 'T032E2E';
/** A recognisable, never-real API key — the literal string verification step 7 greps for. */
const TEST_API_KEY = 'T032E2E_SECRET_API_KEY_DO_NOT_LOG_ME';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let countryA: number;
let countryB: number;
let tenantA: number;
let merchantA: number;
/** T-118 — every `POST /rewards` body needs a `categoryId` now that `reward_systems.category_id`
 * is `NOT NULL`; resolved once against T-116's seeded `UNCATEGORIZED` category rather than
 * hard-coded (its id is a deployment detail, same reasoning `T118_001`'s own migration uses). */
let uncategorizedCategoryId: number;
/** T-118's own describe block's fixture category/sub-category ids — cleaned up in the file's
 * one root `afterAll`, not that describe block's own, so the delete always runs *after* every
 * `reward_systems` row referencing them has already been removed (see that `afterAll`'s own
 * comment on ordering). */
let t118CategoryId: number | undefined;
let t118SubCategoryId: number | undefined;
let t118OtherCategoryId: number | undefined;
/** Every `reward_systems.id` this suite creates, deleted in `afterAll` regardless of outcome. */
const createdRewardIds = new Set<number>();

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
  const email = `t032-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-032 ${key}`,
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

function patch(key: string, path: string, body: unknown) {
  return http()
    .patch(`/api/v1${path}`)
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

// --- fixtures ------------------------------------------------------------------------------------

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
    { tenantId: tenantIdValue, code, countryCode: COUNTRY_A_CODE },
  );
  return created.id;
}

let systemCodeCounter = 0;
function systemCode(suffix: string): string {
  systemCodeCounter += 1;
  return `${SYSTEM_CODE_PREFIX}_${Date.now()}_${systemCodeCounter}_${suffix}`
    .slice(0, 50)
    .toUpperCase();
}

// --- lifecycle -------------------------------------------------------------------------------

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), T032_SUITE);

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

  const [uncategorized] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.reward_categories
      WHERE tenant_id = 1 AND category_code = 'UNCATEGORIZED'`,
  );
  if (uncategorized === undefined) {
    throw new Error('T-116 UNCATEGORIZED reward category not found — run db:migrate first');
  }
  uncategorizedCategoryId = uncategorized.id;

  countryA = await ensureCountry(COUNTRY_A_CODE, 'T-032 e2e country A');
  countryB = await ensureCountry(COUNTRY_B_CODE, 'T-032 e2e country B');
  tenantA = await ensureTenant('T032E2E_TENANT_A', countryA);
  merchantA = await ensureMerchant('T032E2E_MERCHANT_A', tenantA);

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
  await makeActor('checkerA', 'checker', {
    countryId: countryA,
    tenantId: tenantA,
    merchantId: null,
  });
  await makeActor('merchantA', 'merchant', {
    countryId: countryA,
    tenantId: tenantA,
    merchantId: merchantA,
  });
});

/**
 * Cleanup order matters, and it previously mattered in a way that broke silently: this suite's
 * only `reward_policy_caps`-creating test ("caps: create and list under a policy", below) leaves
 * a cap row whose `fk_rpc_policy` FK (`reward_policy_id → reward_policies.id`, `ON DELETE NO
 * ACTION` — confirmed live with `pg_get_constraintdef`) is **not** cascading. Deleting
 * `reward_policies` while a `reward_policy_caps` row still referenced it therefore threw a
 * foreign-key-violation *inside* this `afterAll`, and because the throw happened before
 * `app.close()`, the real Nest HTTP server and its Sequelize pool were left open — which is what
 * kept the Jest worker process alive indefinitely (idle Postgres connections, frozen CPU: the
 * process was not stuck computing anything, it was simply never told to shut down). This is not
 * hypothetical: every one of this suite's own test rows were found still present in the live DB
 * (every test through the last one in the file had run and committed real data) with none of this
 * cleanup having executed — proof the hang was here, in teardown, not in the request path or
 * `RewardsService`/`reward-policy-caps.repository.ts` under test.
 *
 * Two independent fixes, both required:
 *  1. Delete `reward_policy_caps` first (via a `reward_policy_id` subquery scoped to this suite's
 *     own `createdRewardIds`) so the later `reward_policies` delete never hits the FK.
 *  2. Wrap every cleanup statement in `try/finally` so a *future* cleanup failure (a new FK this
 *     suite doesn't yet know about, a locked row, anything) still reaches `app.close()` rather
 *     than leaking the app and silently hanging the whole Jest process again.
 */
afterAll(async () => {
  try {
    if (db !== undefined) {
      if (createdRewardIds.size > 0) {
        await exec(
          `DELETE FROM reward_config.reward_policy_caps
            WHERE reward_policy_id IN (
              SELECT id FROM reward_config.reward_policies WHERE reward_system_id IN (:ids)
            )`,
          { ids: [...createdRewardIds] },
        );
        await exec(
          'DELETE FROM reward_config.reward_country_assignments WHERE reward_id IN (:ids)',
          {
            ids: [...createdRewardIds],
          },
        );
        await exec('DELETE FROM reward_config.reward_policies WHERE reward_system_id IN (:ids)', {
          ids: [...createdRewardIds],
        });
        await exec('DELETE FROM reward_config.reward_systems WHERE id IN (:ids)', {
          ids: [...createdRewardIds],
        });
      }
      // T-118's own fixture rows — deleted only now, after every `reward_systems` row that
      // might reference them (above) is already gone, so this never trips
      // `fk_rws_category`/`fk_rws_sub_category`.
      if (t118SubCategoryId !== undefined) {
        await exec('DELETE FROM reward_config.reward_sub_categories WHERE id = :id', {
          id: t118SubCategoryId,
        });
      }
      if (t118CategoryId !== undefined || t118OtherCategoryId !== undefined) {
        await exec('DELETE FROM reward_config.reward_categories WHERE id IN (:ids)', {
          ids: [t118CategoryId, t118OtherCategoryId].filter((id): id is number => id !== undefined),
        });
      }
      for (const actor of actors.values()) {
        await exec('DELETE FROM reward_portal.portal_users WHERE id = :id', { id: actor.userId });
      }
      await removeEncryptionKeys(db, T032_SUITE);
    }
  } finally {
    if (app !== undefined) await app.close();
  }
});

// --- helpers used by several describe blocks --------------------------------------------------

async function createReward(
  overrides: Partial<{
    name: string;
    systemCode: string;
    connectorConfig: Record<string, unknown>;
  }> = {},
) {
  const response = await post('super', '/rewards', {
    systemCode: overrides.systemCode ?? systemCode('C'),
    name: overrides.name ?? 'T-032 e2e reward',
    rewardType: 'monetary',
    connectorType: 'internal_api',
    categoryId: uncategorizedCategoryId,
    ...(overrides.connectorConfig === undefined
      ? {}
      : { connectorConfig: overrides.connectorConfig }),
  });
  expect(response.status).toBe(201);
  const id = response.body.data.id as number;
  createdRewardIds.add(id);
  return { id, body: response.body.data };
}

// --- the suite -------------------------------------------------------------------------------

describe('T-032 — POST /rewards — authorship', () => {
  it('TC-1: super_admin creates a reward system — 201, tenant_id NULL', async () => {
    const code = systemCode('TC1');
    const response = await post('super', '/rewards', {
      systemCode: code,
      name: 'TC-1 reward',
      rewardType: 'monetary',
      connectorType: 'internal_api',
      categoryId: uncategorizedCategoryId,
    });

    expect(response.status).toBe(201);
    expect(response.body.data.systemCode).toBe(code);
    createdRewardIds.add(response.body.data.id as number);

    const [row] = await sql<{ tenant_id: number | null }>(
      'SELECT tenant_id FROM reward_config.reward_systems WHERE system_code = :code',
      { code },
    );
    expect(row.tenant_id).toBeNull();
  });

  it('TC-2: country_admin POST /rewards → 403', async () => {
    const response = await post('adminA', '/rewards', {
      systemCode: systemCode('TC2'),
      name: 'x',
      rewardType: 'monetary',
      connectorType: 'internal_api',
    });
    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'PERM_DENIED');
  });

  it('TC-4: tenant_admin / checker / merchant POST /rewards → 403 for each', async () => {
    for (const key of ['tenantA', 'checkerA', 'merchantA']) {
      const response = await post(key, '/rewards', {
        systemCode: systemCode('TC4'),
        name: 'x',
        rewardType: 'monetary',
        connectorType: 'internal_api',
      });
      expect(response.status).toBe(403);
    }
  });

  it('unauthenticated → 401', async () => {
    const response = await http()
      .post('/api/v1/rewards')
      .send({
        systemCode: systemCode('UNAUTH'),
        name: 'x',
        rewardType: 'monetary',
        connectorType: 'internal_api',
      });
    expect(response.status).toBe(401);
  });

  it('TC-16: duplicate systemCode → 409', async () => {
    const code = systemCode('TC16');
    const first = await post('super', '/rewards', {
      systemCode: code,
      name: 'first',
      rewardType: 'monetary',
      connectorType: 'internal_api',
      categoryId: uncategorizedCategoryId,
    });
    expect(first.status).toBe(201);
    createdRewardIds.add(first.body.data.id as number);

    const second = await post('super', '/rewards', {
      systemCode: code,
      name: 'second',
      rewardType: 'monetary',
      connectorType: 'internal_api',
      categoryId: uncategorizedCategoryId,
    });
    expect(second.status).toBe(409);
    expectErrorEnvelope(second.body, 'REWARD_SYSTEM_CODE_EXISTS');
  });

  /**
   * TC-15's literal wording is "Invalid reward_type → 400 against the enum" — but `reward_type`
   * is deliberately **not** an enum (11-BUDGETS-AND-LIMITS.md §3.1: *"reward_systems.reward_type
   * is free text with no CHECK and legacy rows exist, so the portal does not constrain it
   * retrospectively"*), a direct conflict this task's own implementation note 6 creates with the
   * design doc. Per AGENT-PROTOCOL §3 the design doc wins, and this test proves the enum
   * behaviour TC-15 is actually checking for — a constrained vocabulary rejecting an
   * out-of-set value — against `connectorType`, the field that genuinely is one. Flagged in the
   * completion report.
   */
  it('TC-15 (redirected): an unrecognised connectorType is a 400 against the enum', async () => {
    const response = await post('super', '/rewards', {
      systemCode: systemCode('TC15'),
      name: 'bad connector',
      rewardType: 'monetary',
      connectorType: 'carrier_pigeon',
      categoryId: uncategorizedCategoryId,
    });
    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
    expect(response.body.error.details).toEqual([{ field: 'connectorType', code: 'IS_IN' }]);
  });

  it('reward_type accepts free text — no CHECK constraint, per the design doc', async () => {
    const response = await post('super', '/rewards', {
      systemCode: systemCode('FREETEXT'),
      name: 'free text reward type',
      rewardType: 'brand_new_reward_type',
      connectorType: 'internal_api',
      categoryId: uncategorizedCategoryId,
    });
    expect(response.status).toBe(201);
    createdRewardIds.add(response.body.data.id as number);
    expect(response.body.data.rewardType).toBe('brand_new_reward_type');
  });
});

describe('T-032 — TC-3/verification step 6 — the service-layer assertion overrides the permission table', () => {
  it('a maker granted reward:create by editing role_entity_permissions is still refused', async () => {
    const [before] = await sql<{ actions: string }>(
      `SELECT actions FROM reward_config.role_entity_permissions
        WHERE role = 'maker' AND entity = 'reward'`,
    );
    expect(before).toBeDefined();
    const [versionRow] = await sql<{ config_value: string }>(
      `SELECT config_value FROM reward_config.rbac_cache_config WHERE config_key = 'rbac_version:maker'`,
    );
    const versionBefore = versionRow?.config_value;

    try {
      await exec(
        `UPDATE reward_config.role_entity_permissions
            SET actions = '["view","create"]', updated_at = now()
          WHERE role = 'maker' AND entity = 'reward'`,
      );
      await exec(
        `UPDATE reward_config.rbac_cache_config
            SET config_value = (config_value::bigint + 1)::text, updated_at = now()
          WHERE config_key = 'rbac_version:maker'`,
      );

      const attemptedCode = systemCode('TC3');
      const response = await post('makerA', '/rewards', {
        systemCode: attemptedCode,
        name: 'should never exist',
        rewardType: 'monetary',
        connectorType: 'internal_api',
        // A valid body all the way through the `ValidationPipe` (categoryId is required, T-118)
        // is what makes this test actually exercise the service-layer assertion it's named for
        // — a request that 400s on a missing field never reaches `assertRole` at all.
        categoryId: uncategorizedCategoryId,
      });

      expect(response.status).toBe(403);
      expectErrorEnvelope(response.body, 'PERM_DENIED');

      const [leaked] = await sql<{ id: number }>(
        `SELECT id FROM reward_config.reward_systems WHERE system_code = :code`,
        { code: attemptedCode },
      );
      expect(leaked).toBeUndefined();
    } finally {
      await exec(
        `UPDATE reward_config.role_entity_permissions
            SET actions = :actions, updated_at = now()
          WHERE role = 'maker' AND entity = 'reward'`,
        { actions: before.actions },
      );
      if (versionBefore !== undefined) {
        await exec(
          `UPDATE reward_config.rbac_cache_config SET config_value = :value, updated_at = now()
            WHERE config_key = 'rbac_version:maker'`,
          { value: versionBefore },
        );
      }
    }

    const after = await post('makerA', '/rewards', {
      systemCode: systemCode('TC3_AFTER'),
      name: 'x',
      rewardType: 'monetary',
      connectorType: 'internal_api',
    });
    expect(after.status).toBe(403);
  });
});

describe('T-032 — read visibility (TC-5, TC-6, TC-21)', () => {
  let assignedRewardId: number;
  let unassignedRewardId: number;

  beforeAll(async () => {
    assignedRewardId = (await createReward({ name: 'assigned to A' })).id;
    unassignedRewardId = (await createReward({ name: 'never assigned' })).id;

    const assign = await post('super', `/rewards/${String(assignedRewardId)}/countries`, {
      countryId: countryA,
    });
    expect(assign.status).toBe(201);
  });

  it('super_admin lists rewards — sees all global rewards, including the unassigned one', async () => {
    const response = await get('super', '/rewards?pageSize=100');
    expect(response.status).toBe(200);
    const ids = (response.body.data as { id: number }[]).map((reward) => reward.id);
    expect(ids).toContain(assignedRewardId);
    expect(ids).toContain(unassignedRewardId);
  });

  it('TC-5: country_admin/maker of country A list only rewards assigned to A', async () => {
    for (const key of ['adminA', 'makerA']) {
      const response = await get(key, '/rewards?pageSize=100');
      expect(response.status).toBe(200);
      const ids = (response.body.data as { id: number }[]).map((reward) => reward.id);
      expect(ids).toContain(assignedRewardId);
      expect(ids).not.toContain(unassignedRewardId);
    }
  });

  it('TC-6: a reward not assigned to A, read by A’s country admin → 404', async () => {
    const response = await get('adminA', `/rewards/${String(unassignedRewardId)}`);
    expect(response.status).toBe(404);
  });

  it('country_admin of a different country never sees a reward assigned only to A', async () => {
    const response = await get('adminB', '/rewards?pageSize=100');
    expect(response.status).toBe(200);
    const ids = (response.body.data as { id: number }[]).map((reward) => reward.id);
    expect(ids).not.toContain(assignedRewardId);
  });

  it('TC-21: merchant lists rewards → 403 (no reward:view in the matrix)', async () => {
    const response = await get('merchantA', '/rewards?pageSize=100');
    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'PERM_DENIED');
  });
});

describe('T-032 — country assignment (TC-7, TC-8, TC-20)', () => {
  it('TC-7: assign a reward to 3 countries — 3 rows, assignedBy present', async () => {
    const { id } = await createReward({ name: 'multi-assign' });
    const countryC = await ensureCountry('W3', 'T-032 e2e country C');
    const countryD = await ensureCountry('W4', 'T-032 e2e country D');

    for (const countryId of [countryA, countryC, countryD]) {
      const response = await post('super', `/rewards/${String(id)}/countries`, { countryId });
      expect(response.status).toBe(201);
      expect(response.body.data).toHaveProperty('assignedBy');
    }

    const rows = await sql<{ country_id: number }>(
      'SELECT country_id FROM reward_config.reward_country_assignments WHERE reward_id = :id',
      { id },
    );
    expect(rows).toHaveLength(3);
  });

  it('TC-8: assigning the same reward/country twice is idempotent — no duplicate row', async () => {
    const { id } = await createReward({ name: 'idempotent-assign' });

    const first = await post('super', `/rewards/${String(id)}/countries`, {
      countryId: countryA,
    });
    expect([200, 201]).toContain(first.status);
    const second = await post('super', `/rewards/${String(id)}/countries`, {
      countryId: countryA,
    });
    expect([200, 201, 409]).toContain(second.status);

    const rows = await sql<{ id: number }>(
      'SELECT id FROM reward_config.reward_country_assignments WHERE reward_id = :id AND country_id = :countryId',
      { id, countryId: countryA },
    );
    expect(rows).toHaveLength(1);
  });

  it('unassigning an unused reward → 204, row removed', async () => {
    const { id } = await createReward({ name: 'unassign-me' });
    await post('super', `/rewards/${String(id)}/countries`, { countryId: countryA });

    const response = await del('super', `/rewards/${String(id)}/countries/${String(countryA)}`);
    expect(response.status).toBe(204);

    const rows = await sql<{ id: number }>(
      'SELECT id FROM reward_config.reward_country_assignments WHERE reward_id = :id AND country_id = :countryId',
      { id, countryId: countryA },
    );
    expect(rows).toHaveLength(0);
  });

  it('TC-20: DELETE a reward assigned to a country → 422, unassign first', async () => {
    const { id } = await createReward({ name: 'delete-blocked' });
    await post('super', `/rewards/${String(id)}/countries`, { countryId: countryA });

    const response = await del('super', `/rewards/${String(id)}`);
    expect(response.status).toBe(422);
    expectErrorEnvelope(response.body, 'REWARD_HAS_COUNTRY_ASSIGNMENTS');

    const [row] = await sql<{ id: number }>(
      'SELECT id FROM reward_config.reward_systems WHERE id = :id',
      { id },
    );
    expect(row).toBeDefined();
  });

  it('DELETE an unassigned reward → 204, soft-deleted (reward_systems is paranoid)', async () => {
    const { id } = await createReward({ name: 'delete-ok' });

    const response = await del('super', `/rewards/${String(id)}`);
    expect(response.status).toBe(204);
    // Deliberately *not* removed from `createdRewardIds`: `reward_systems` is `paranoid: true`
    // (implementation note in this file's header on `remove`), so this `DELETE` only sets
    // `deleted_at` — the row still physically exists and still needs `afterAll`'s raw, non-
    // paranoid `DELETE FROM reward_config.reward_systems WHERE id IN (:ids)` to actually remove
    // it. Dropping the id here (as this test previously did) left a soft-deleted-but-physically-
    // present row behind after every real run — found live in the shared dev DB while
    // re-verifying this suite for T-032's review fix.

    const [row] = await sql<{ id: number; deleted_at: Date | null }>(
      'SELECT id, deleted_at FROM reward_config.reward_systems WHERE id = :id',
      { id },
    );
    expect(row.deleted_at).not.toBeNull();
  });
});

describe('T-032 — connector_config encryption (TC-10, TC-11, TC-12, TC-13, TC-14/verification 3/4/5/7)', () => {
  it('TC-10/verification 3: stored encrypted — ciphertext in the DB, the raw API key is not readable', async () => {
    const { id } = await createReward({
      name: 'has connector config',
      connectorConfig: { apiKey: TEST_API_KEY },
    });

    const [row] = await sql<{ connector_config: string }>(
      'SELECT connector_config FROM reward_config.reward_systems WHERE id = :id',
      { id },
    );
    expect(row.connector_config).toBeDefined();
    expect(row.connector_config).not.toContain(TEST_API_KEY);
    expect(row.connector_config).toContain('__enc');
    expect(row.connector_config).toMatch(/v1\./);
  });

  it('TC-11/verification 4: GET /rewards (list) — connectorConfigPreview is absent entirely', async () => {
    await createReward({ name: 'listed with secret', connectorConfig: { apiKey: TEST_API_KEY } });

    const response = await get('super', '/rewards?pageSize=100');
    expect(response.status).toBe(200);
    for (const row of response.body.data as Record<string, unknown>[]) {
      expect(row).not.toHaveProperty('connectorConfig');
      expect(row).not.toHaveProperty('connectorConfigPreview');
    }
    expect(JSON.stringify(response.body)).not.toContain(TEST_API_KEY);
  });

  it('TC-12/verification 5: GET /rewards/:id — connectorConfigPreview is masked, never plaintext', async () => {
    const { id } = await createReward({
      name: 'detail with secret',
      connectorConfig: { apiKey: TEST_API_KEY },
    });

    const response = await get('super', `/rewards/${String(id)}`);
    expect(response.status).toBe(200);
    expect(response.body.data.connectorConfigPreview).toEqual({
      apiKey: `••••${TEST_API_KEY.slice(-4)}`,
    });
    expect(JSON.stringify(response.body)).not.toContain(TEST_API_KEY);
  });

  it('a reward created with no connectorConfig shows connectorConfigPreview: null on detail read', async () => {
    const { id } = await createReward({ name: 'no connector config' });
    const response = await get('super', `/rewards/${String(id)}`);
    expect(response.status).toBe(200);
    expect(response.body.data.connectorConfigPreview).toBeNull();
  });

  it('TC-13: updating connectorConfig audits that it changed, never the value', async () => {
    const { id } = await createReward({ name: 'to be updated' });
    const newKey = `${TEST_API_KEY}_UPDATED`;

    const response = await patch('super', `/rewards/${String(id)}`, {
      connectorConfig: { apiKey: newKey },
    });
    expect(response.status).toBe(200);
    expect(response.body.data.connectorConfigPreview).toEqual({
      apiKey: `••••${newKey.slice(-4)}`,
    });

    const [audit] = await sql<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM reward_portal.portal_audit_log
        WHERE event_type = 'reward_updated' AND target_id = :id
        ORDER BY occurred_at DESC LIMIT 1`,
      { id: String(id) },
    );
    expect(audit).toBeDefined();
    expect(audit.detail).toMatchObject({ connectorConfigChanged: true });
    expect(JSON.stringify(audit.detail)).not.toContain(newKey);
  });

  it('redactSql redacts the positional placeholders and inlined VALUES tuples of a real connector_config statement', () => {
    // The exact shape `sequelize.provider.ts`'s own `logging` callback receives for the
    // INSERT/UPDATE this suite's own TC-10/TC-13 calls trigger for real (confirmed against this
    // session's own captured `console.debug` output: `UPDATE "reward_config"."reward_systems"
    // SET "connector_config"=$1, ...`) — never with the bind *value* embedded in the string at
    // all, only the `$1`/`$2` positional reference. `redactSql` still redacts that reference
    // (the belt to the driver's own braces), so no future dialect/config change that started
    // inlining values could silently regress this.
    const statement =
      'Executing (default): UPDATE "reward_config"."reward_systems" ' +
      'SET "connector_config"=$1,"updated_at"=$2 WHERE ("id" = $3)';
    expect(redactSql(statement)).toBe(
      'Executing (default): UPDATE "reward_config"."reward_systems" ' +
        'SET "connector_config"=$?,"updated_at"=$? WHERE ("id" = $?)',
    );
  });

  it('TC-14/verification 7: no server log line captured during a real connector_config create/update ever contains the plaintext API key', async () => {
    // The genuine, end-to-end version of verification step 7 ("grep -ri '<the test api key>'
    // logs/"): every line `sequelize.provider.ts` would have written to stdout during this
    // suite's own real TC-10 (create) and TC-13 (update) calls — both of which round-tripped
    // `TEST_API_KEY` through the real HTTP → service → encryption → INSERT/UPDATE path already
    // exercised above — is captured here and asserted clean, rather than asserted against a
    // hand-built string.
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      const created = await createReward({
        name: 'log-capture check',
        connectorConfig: { apiKey: TEST_API_KEY },
      });
      await patch('super', `/rewards/${String(created.id)}`, {
        connectorConfig: { apiKey: `${TEST_API_KEY}_2` },
      });

      const loggedLines = debugSpy.mock.calls.map((call) => String(call[0]));
      expect(loggedLines.length).toBeGreaterThan(0);
      for (const line of loggedLines) {
        expect(line).not.toContain(TEST_API_KEY);
      }
    } finally {
      debugSpy.mockRestore();
    }
  });
});

describe('T-032 — reward_policies (TC-17, TC-18)', () => {
  it('TC-17: create a reward_policy — 201, linked to the system', async () => {
    const { id } = await createReward({ name: 'has a policy' });

    const response = await post('super', `/rewards/${String(id)}/policies`, {
      policyCode: 'STANDARD',
      name: 'Standard policy',
    });
    expect(response.status).toBe(201);
    expect(response.body.data.rewardSystemId).toBe(id);

    const list = await get('super', `/rewards/${String(id)}/policies`);
    expect(list.status).toBe(200);
    expect((list.body.data as { id: number }[]).map((row) => row.id)).toContain(
      response.body.data.id,
    );
  });

  it('TC-18: duplicate policyCode on the same reward → 409', async () => {
    const { id } = await createReward({ name: 'dup policy code' });
    const first = await post('super', `/rewards/${String(id)}/policies`, {
      policyCode: 'DUP',
      name: 'first',
    });
    expect(first.status).toBe(201);

    const second = await post('super', `/rewards/${String(id)}/policies`, {
      policyCode: 'DUP',
      name: 'second',
    });
    expect(second.status).toBe(409);
    expectErrorEnvelope(second.body, 'REWARD_POLICY_CODE_EXISTS');
  });

  it('a duplicate policyCode on a different reward is not blocked', async () => {
    const { id: idA } = await createReward({ name: 'policy scope A' });
    const { id: idB } = await createReward({ name: 'policy scope B' });

    const first = await post('super', `/rewards/${String(idA)}/policies`, {
      policyCode: 'SHARED',
      name: 'a',
    });
    expect(first.status).toBe(201);
    const second = await post('super', `/rewards/${String(idB)}/policies`, {
      policyCode: 'SHARED',
      name: 'b',
    });
    expect(second.status).toBe(201);
  });

  it('policies/caps routes are super_admin only — 403 for every other role', async () => {
    const { id } = await createReward({ name: 'policy authz' });
    for (const key of ['adminA', 'tenantA', 'makerA', 'checkerA', 'merchantA']) {
      const response = await get(key, `/rewards/${String(id)}/policies`);
      expect(response.status).toBe(403);
    }
  });

  it('caps: create and list under a policy', async () => {
    const { id } = await createReward({ name: 'has caps' });
    const policy = await post('super', `/rewards/${String(id)}/policies`, {
      policyCode: 'CAPPED',
      name: 'Capped policy',
    });
    const policyId = policy.body.data.id as number;

    const created = await post(
      'super',
      `/rewards/${String(id)}/policies/${String(policyId)}/caps`,
      { capType: 'per_customer', frequencyValue: 1, frequencyUnit: 'day', maxOccurrences: 3 },
    );
    expect(created.status).toBe(201);
    expect(created.body.data.rewardPolicyId).toBe(policyId);

    const list = await get('super', `/rewards/${String(id)}/policies/${String(policyId)}/caps`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);

    const capId = created.body.data.id as number;
    const updated = await patch(
      'super',
      `/rewards/${String(id)}/policies/${String(policyId)}/caps/${String(capId)}`,
      { status: 'inactive' },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.data.status).toBe('inactive');
  });
});

describe('T-032 — PATCH /rewards/:id (TC-22)', () => {
  it('super_admin PATCHes a reward — 200, audit written with a field diff', async () => {
    const { id } = await createReward({ name: 'before name' });

    const response = await patch('super', `/rewards/${String(id)}`, { name: 'after name' });
    expect(response.status).toBe(200);
    expect(response.body.data.name).toBe('after name');

    const [audit] = await sql<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM reward_portal.portal_audit_log
        WHERE event_type = 'reward_updated' AND target_id = :id
        ORDER BY occurred_at DESC LIMIT 1`,
      { id: String(id) },
    );
    expect(audit).toBeDefined();
    const changes = (audit.detail as { changes?: Record<string, unknown> }).changes;
    expect(changes).toHaveProperty('name');
  });

  it('maker PATCHes a reward → 403', async () => {
    const { id } = await createReward({ name: 'maker cannot touch' });
    const response = await patch('makerA', `/rewards/${String(id)}`, { name: 'nope' });
    expect(response.status).toBe(403);
  });

  it('TC-22: status=inactive does not disturb an existing country assignment', async () => {
    const { id } = await createReward({ name: 'going inactive' });
    await post('super', `/rewards/${String(id)}/countries`, { countryId: countryA });

    const response = await patch('super', `/rewards/${String(id)}`, { status: 'inactive' });
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('inactive');

    const rows = await sql<{ id: number }>(
      'SELECT id FROM reward_config.reward_country_assignments WHERE reward_id = :id',
      { id },
    );
    expect(rows).toHaveLength(1);
  });
});

describe('T-118 — reward_systems.category_id/sub_category_id', () => {
  let categoryId: number;
  let subCategoryId: number;
  let otherCategoryId: number;

  beforeAll(async () => {
    const [category] = await sql<{ id: number }>(
      `INSERT INTO reward_config.reward_categories (tenant_id, category_code, name, status)
       VALUES (1, :code, :code, 'active') RETURNING id`,
      { code: `T118_CAT_${String(Date.now())}` },
    );
    categoryId = category.id;
    t118CategoryId = categoryId;

    const [subCategory] = await sql<{ id: number }>(
      `INSERT INTO reward_config.reward_sub_categories (category_id, sub_category_code, name, status)
       VALUES (:categoryId, :code, :code, 'active') RETURNING id`,
      { categoryId, code: `T118_SUB_${String(Date.now())}` },
    );
    subCategoryId = subCategory.id;
    t118SubCategoryId = subCategoryId;

    const [otherCategory] = await sql<{ id: number }>(
      `INSERT INTO reward_config.reward_categories (tenant_id, category_code, name, status)
       VALUES (1, :code, :code, 'active') RETURNING id`,
      { code: `T118_CAT_OTHER_${String(Date.now())}` },
    );
    otherCategoryId = otherCategory.id;
    t118OtherCategoryId = otherCategoryId;
  });

  // Cleanup for these three rows lives in the file's one root `afterAll`, not here — see that
  // hook's own comment for why (it must run after every `reward_systems` row created by any
  // describe block, including this one, is already deleted).

  it('TC-2/TC-5: creates a reward with a categoryId and subCategoryId — 201, GET resolves both', async () => {
    const response = await post('super', '/rewards', {
      systemCode: systemCode('T118_2'),
      name: 'has category and sub-category',
      rewardType: 'monetary',
      connectorType: 'internal_api',
      categoryId,
      subCategoryId,
    });
    expect(response.status).toBe(201);
    const id = response.body.data.id as number;
    createdRewardIds.add(id);
    expect(response.body.data.categoryId).toBe(categoryId);
    expect(response.body.data.subCategoryId).toBe(subCategoryId);

    const detail = await get('super', `/rewards/${String(id)}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.categoryId).toBe(categoryId);
    expect(detail.body.data.subCategoryId).toBe(subCategoryId);
    expect(typeof detail.body.data.categoryName).toBe('string');
    expect(typeof detail.body.data.subCategoryName).toBe('string');
  });

  it('creates a reward with a categoryId and no subCategoryId — 201, subCategoryId/subCategoryName null', async () => {
    const response = await post('super', '/rewards', {
      systemCode: systemCode('T118_NOSUB'),
      name: 'category only',
      rewardType: 'monetary',
      connectorType: 'internal_api',
      categoryId,
    });
    expect(response.status).toBe(201);
    createdRewardIds.add(response.body.data.id as number);
    expect(response.body.data.categoryId).toBe(categoryId);
    expect(response.body.data.subCategoryId).toBeNull();
    expect(response.body.data.subCategoryName).toBeNull();
  });

  it('TC-3: a subCategoryId belonging to a different category → 400', async () => {
    const response = await post('super', '/rewards', {
      systemCode: systemCode('T118_3'),
      name: 'mismatched sub-category',
      rewardType: 'monetary',
      connectorType: 'internal_api',
      categoryId: otherCategoryId,
      subCategoryId,
    });
    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
    expect(response.body.error.details).toEqual([
      { field: 'subCategoryId', code: 'REWARD_SUB_CATEGORY_CATEGORY_MISMATCH' },
    ]);
  });

  it('TC-4: no categoryId at all → 400', async () => {
    const response = await post('super', '/rewards', {
      systemCode: systemCode('T118_4'),
      name: 'no category',
      rewardType: 'monetary',
      connectorType: 'internal_api',
    });
    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
    expect(response.body.error.details).toEqual([{ field: 'categoryId', code: 'IS_INT' }]);
  });

  it('a categoryId that does not reference a real category → 404', async () => {
    const response = await post('super', '/rewards', {
      systemCode: systemCode('T118_404'),
      name: 'bogus category',
      rewardType: 'monetary',
      connectorType: 'internal_api',
      categoryId: 999_999_999,
    });
    expect(response.status).toBe(404);
  });

  it('categoryId/subCategoryId are immutable-by-replacement — rejected on PATCH', async () => {
    const { id } = await createReward({ name: 'immutable category' });
    const response = await patch('super', `/rewards/${String(id)}`, {
      categoryId: otherCategoryId,
    });
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([
      { field: 'categoryId', code: 'UNEXPECTED_FIELD' },
    ]);
  });

  it('TC-6: verification step — existing connector-config test cases from T-032 are unaffected', async () => {
    const { id } = await createReward({
      name: 'still works post-T-118',
      connectorConfig: { apiKey: TEST_API_KEY },
    });
    const detail = await get('super', `/rewards/${String(id)}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.connectorConfigPreview).toEqual({
      apiKey: `••••${TEST_API_KEY.slice(-4)}`,
    });
    expect(detail.body.data.categoryId).toBe(uncategorizedCategoryId);
  });
});
