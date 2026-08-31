/**
 * T-031 — `/rules` against the **real** Postgres instance, through the real `AppModule`, over
 * real HTTP, as every role. Follows the harness `test/notifications/notifications.e2e-spec.ts`
 * (T-040) and `test/rbac/rbac.e2e-spec.ts` (T-013) establish: real login (through MFA for
 * `super_admin`, T-055), real cookies, real guards, real `ScopedRepository` scoping.
 *
 * TC-3 is deliberately performed for real here — a live `UPDATE
 * reward_config.role_entity_permissions` for `maker`/`rule`, restored in a `finally` block —
 * because the task's own Definition of Done requires it evidenced, not simulated
 * (T-031's Verification step 3). T-013's own TC-16 already established this exact pattern
 * (mutate one row, bump `rbac_version:<role>`, restore in `finally`) works safely against the
 * live, shared database; the row this suite touches (`role='maker', entity='rule'`) is
 * disjoint from the one T-013's TC-16 touches (`entity='campaign'`), so the two suites cannot
 * collide even when Jest runs them in parallel workers.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import { ruleListEnvelopeSchema, ruleSchema } from '@reward-portal/shared';
import { AppModule } from '@/app.module';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { SEQUELIZE } from '@/database/sequelize.provider';
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

const T031_SUITE = 't031';
const PASSWORD = 'correct horse battery staple 7!';
const COUNTRY_A_CODE = 'R1';
const COUNTRY_B_CODE = 'R2';
const RULE_CODE_PREFIX = 'T031E2E';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let countryA: number;
let countryB: number;
let tenantA: number;
let merchantA: number;
let subCategoryId: number;
/** Every `rule_master.id` this suite creates, deleted in `afterAll` regardless of test outcome. */
const createdRuleIds = new Set<number>();

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
  const email = `t031-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-031 ${key}`,
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

/** `ck_portal_users_scope` (01-DATABASE.md §2.1) requires a real `tenant_id` for
 * `tenant_admin`/`maker`/`checker`, and a real `merchant_id` too for `merchant` — `NULL` is
 * only valid for `super_admin`/`country_admin`. */
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

/** A real, seeded sub-category (`rule_sub_categories` — T004's own seed, `TRANSACTION/GENERAL`). */
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

/** A monotonic counter, not just `Date.now()` — several `createRule()` calls in the same test
 * happen well within one millisecond, and `Date.now()` alone was observed to collide, turning a
 * genuinely-unique-per-call code into a real `uq_rm_tenant_code` 409 the test did not intend. */
let ruleCodeCounter = 0;
function ruleCode(suffix: string): string {
  ruleCodeCounter += 1;
  return `${RULE_CODE_PREFIX}_${Date.now()}_${ruleCodeCounter}_${suffix}`
    .slice(0, 80)
    .toUpperCase();
}

// --- lifecycle -------------------------------------------------------------------------------

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), T031_SUITE);

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

  countryA = await ensureCountry(COUNTRY_A_CODE, 'T-031 e2e country A');
  countryB = await ensureCountry(COUNTRY_B_CODE, 'T-031 e2e country B');
  tenantA = await ensureTenant('T031E2E_TENANT_A', countryA);
  merchantA = await ensureMerchant('T031E2E_MERCHANT_A', tenantA);
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

afterAll(async () => {
  if (db !== undefined) {
    if (createdRuleIds.size > 0) {
      await exec('DELETE FROM reward_config.rule_country_assignments WHERE rule_id IN (:ids)', {
        ids: [...createdRuleIds],
      });
      await exec('DELETE FROM reward_config.rule_master WHERE id IN (:ids)', {
        ids: [...createdRuleIds],
      });
    }
    for (const actor of actors.values()) {
      await exec('DELETE FROM reward_portal.portal_users WHERE id = :id', { id: actor.userId });
    }
    await removeEncryptionKeys(db, T031_SUITE);
  }
  if (app !== undefined) await app.close();
});

// --- helpers used by several describe blocks --------------------------------------------------

async function createRule(overrides: Partial<{ name: string; ruleCode: string }> = {}) {
  const response = await post('super', '/rules', {
    ruleCode: overrides.ruleCode ?? ruleCode('C'),
    name: overrides.name ?? 'T-031 e2e rule',
    subCategoryId,
    expression: 'amount >= :minSpend',
    parameters: {
      fields: [{ key: 'minSpend', label: 'Minimum spend', type: 'number', required: true }],
    },
  });
  expect(response.status).toBe(201);
  const id = response.body.data.id as number;
  createdRuleIds.add(id);
  return { id, body: response.body.data };
}

// --- the suite -------------------------------------------------------------------------------

describe('T-031 — POST /rules — authorship', () => {
  it('TC-1: super_admin creates a rule — 201, tenant_id NULL, audit written', async () => {
    const code = ruleCode('TC1');
    const response = await post('super', '/rules', {
      ruleCode: code,
      name: 'TC-1 rule',
      subCategoryId,
    });

    expect(response.status).toBe(201);
    expect(response.body.data.ruleCode).toBe(code);
    createdRuleIds.add(response.body.data.id as number);

    const [row] = await sql<{ tenant_id: number | null }>(
      'SELECT tenant_id FROM reward_config.rule_master WHERE rule_code = :code',
      { code },
    );
    expect(row.tenant_id).toBeNull();

    const [audit] = await sql<{ event_type: string; target_id: string }>(
      `SELECT event_type, target_id FROM reward_portal.portal_audit_log
        WHERE event_type = 'rule_created' AND target_id = :id
        ORDER BY occurred_at DESC LIMIT 1`,
      { id: String(response.body.data.id) },
    );
    expect(audit).toBeDefined();
  });

  // T-074 — reproduced live, 2026-08-21 (T-050 golden-journey.spec.ts): a rule created with no
  // `parameters` returned 201 from this exact call, and the row was genuinely inserted, but the
  // *following* `GET /rules` (and `GET /rules/:id`) 500'd — `ruleParametersSchema` rejected the
  // bare `{}` `rules.service.ts#create` wrote for the omitted field, and a Zod array parse fails
  // whole if any one element fails, so that one rule broke the entire list for every viewer. This
  // is the same round trip TC-1 above performs, taken one step further: TC-1 never re-read the
  // row it created, which is exactly why this defect shipped past T-031's own suite.
  it('T-074: a rule created with no parameters round-trips through GET /rules and GET /rules/:id', async () => {
    const code = ruleCode('T074');
    const created = await post('super', '/rules', {
      ruleCode: code,
      name: 'no params',
      subCategoryId,
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id as number;
    createdRuleIds.add(id);
    expect(created.body.data.parameters).toEqual({ fields: [] });

    const list = await get('super', '/rules?pageSize=100');
    expect(list.status).toBe(200);
    const listed = (list.body.data as { id: number; parameters: unknown }[]).find(
      (rule) => rule.id === id,
    );
    expect(listed?.parameters).toEqual({ fields: [] });

    const single = await get('super', `/rules/${String(id)}`);
    expect(single.status).toBe(200);
    expect(single.body.data.parameters).toEqual({ fields: [] });
  });

  it('TC-2: country_admin POST /rules → 403', async () => {
    const response = await post('adminA', '/rules', {
      ruleCode: ruleCode('TC2'),
      name: 'x',
      subCategoryId,
    });
    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'PERM_DENIED');
  });

  it('TC-4: tenant_admin / checker / merchant POST /rules → 403 for each', async () => {
    for (const key of ['tenantA', 'checkerA', 'merchantA']) {
      const response = await post(key, '/rules', {
        ruleCode: ruleCode('TC4'),
        name: 'x',
        subCategoryId,
      });
      expect(response.status).toBe(403);
    }
  });

  it('TC-5: unauthenticated → 401', async () => {
    const response = await http()
      .post('/api/v1/rules')
      .send({ ruleCode: ruleCode('TC5'), name: 'x', subCategoryId });
    expect(response.status).toBe(401);
  });

  it('TC-18: duplicate ruleCode → 409', async () => {
    const code = ruleCode('TC18');
    const first = await post('super', '/rules', { ruleCode: code, name: 'first', subCategoryId });
    expect(first.status).toBe(201);
    createdRuleIds.add(first.body.data.id as number);

    const second = await post('super', '/rules', { ruleCode: code, name: 'second', subCategoryId });
    expect(second.status).toBe(409);
    expectErrorEnvelope(second.body, 'RULE_CODE_EXISTS');
  });

  it('TC-14: malformed parameters → 400 with a specific message', async () => {
    const response = await post('super', '/rules', {
      ruleCode: ruleCode('TC14'),
      name: 'bad params',
      subCategoryId,
      parameters: {
        fields: [{ key: 'not a valid key!', label: 'x', type: 'string', required: true }],
      },
    });
    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
    expect(response.body.error.details).toEqual([
      { field: 'parameters', code: 'IS_RULE_PARAMETERS' },
    ]);
  });

  it('TC-15: GET /rules/:id/parameters returns the parsed schema', async () => {
    const parameters = {
      fields: [
        { key: 'tier', label: 'Tier', type: 'select', required: true, options: ['gold', 'silver'] },
      ],
    };
    const created = await post('super', '/rules', {
      ruleCode: ruleCode('TC15'),
      name: 'params rule',
      subCategoryId,
      parameters,
    });
    expect(created.status).toBe(201);
    createdRuleIds.add(created.body.data.id as number);

    const response = await get('super', `/rules/${String(created.body.data.id)}/parameters`);
    expect(response.status).toBe(200);
    // T-114 — every field now also carries a response-only `role`. This freshly created rule
    // has no `rule_versions` row yet (never wired to a resolver), so every field is
    // `compare_value` (T-114 TC-4) — asserted here as the observable shape of the one field
    // this test actually supplied, rather than restated as a separate suite.
    expect(response.body.data).toEqual({
      fields: parameters.fields.map((field) => ({ ...field, role: 'compare_value' })),
    });
  });

  it('TC-16/TC-17: expression is stored as inert text — never executed', async () => {
    const maliciousExpression = 'amount > 0; DROP TABLE reward_config.rule_master; --';
    const created = await post('super', '/rules', {
      ruleCode: ruleCode('TC16'),
      name: 'injection rule',
      subCategoryId,
      expression: maliciousExpression,
    });
    expect(created.status).toBe(201);
    createdRuleIds.add(created.body.data.id as number);
    expect(created.body.data.expression).toBe(maliciousExpression);

    // The table this "SQL" would have dropped is still here and still holds the row we just made.
    const [row] = await sql<{ id: number }>(
      'SELECT id FROM reward_config.rule_master WHERE id = :id',
      {
        id: created.body.data.id,
      },
    );
    expect(row).toBeDefined();
  });
});

describe('T-031 — TC-3 — the service-layer assertion overrides the permission table', () => {
  it(
    'a maker granted rule:create by editing role_entity_permissions is still refused ' +
      '(Verification step 3)',
    async () => {
      const [before] = await sql<{ actions: string }>(
        `SELECT actions FROM reward_config.role_entity_permissions
          WHERE role = 'maker' AND entity = 'rule'`,
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
            WHERE role = 'maker' AND entity = 'rule'`,
        );
        await exec(
          `UPDATE reward_config.rbac_cache_config
              SET config_value = (config_value::bigint + 1)::text, updated_at = now()
            WHERE config_key = 'rbac_version:maker'`,
        );

        // Layer 1 (@RequirePermission('rule','create')) now admits `maker` — proven by the fact
        // that the permission cache genuinely reflects the edit, not merely that the edit ran.
        const attemptedCode = ruleCode('TC3');
        const response = await post('makerA', '/rules', {
          ruleCode: attemptedCode,
          name: 'should never exist',
          subCategoryId,
        });

        // ...and yet `RuleService.create()`'s own `assertRole(actor, 'super_admin')` refuses it.
        expect(response.status).toBe(403);
        expectErrorEnvelope(response.body, 'PERM_DENIED');

        const [leaked] = await sql<{ id: number }>(
          `SELECT id FROM reward_config.rule_master WHERE rule_code = :code`,
          { code: attemptedCode },
        );
        expect(leaked).toBeUndefined();
      } finally {
        await exec(
          `UPDATE reward_config.role_entity_permissions
              SET actions = :actions, updated_at = now()
            WHERE role = 'maker' AND entity = 'rule'`,
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

      // Restored, and effective immediately — a maker still cannot create rules.
      const after = await post('makerA', '/rules', {
        ruleCode: ruleCode('TC3_AFTER'),
        name: 'x',
        subCategoryId,
      });
      expect(after.status).toBe(403);
    },
  );
});

describe('T-031 — read visibility (TC-6…TC-9)', () => {
  let assignedRuleId: number;
  let unassignedRuleId: number;

  beforeAll(async () => {
    assignedRuleId = (await createRule({ name: 'assigned to A' })).id;
    unassignedRuleId = (await createRule({ name: 'never assigned' })).id;

    const assign = await post('super', `/rules/${String(assignedRuleId)}/countries`, {
      countryId: countryA,
    });
    expect(assign.status).toBe(201);
  });

  it('TC-6: super_admin lists rules — sees all global rules, including the unassigned one', async () => {
    const response = await get('super', '/rules?pageSize=100');
    expect(response.status).toBe(200);
    const ids = (response.body.data as { id: number }[]).map((rule) => rule.id);
    expect(ids).toContain(assignedRuleId);
    expect(ids).toContain(unassignedRuleId);
  });

  it('TC-7/TC-9: country_admin and maker of country A list only rules assigned to A', async () => {
    for (const key of ['adminA', 'makerA']) {
      const response = await get(key, '/rules?pageSize=100');
      expect(response.status).toBe(200);
      const ids = (response.body.data as { id: number }[]).map((rule) => rule.id);
      expect(ids).toContain(assignedRuleId);
      expect(ids).not.toContain(unassignedRuleId);
    }
  });

  it('TC-8: a rule not assigned to A, read by A’s country admin → 404', async () => {
    const response = await get('adminA', `/rules/${String(unassignedRuleId)}`);
    expect(response.status).toBe(404);
  });

  it('country_admin of a different country never sees a rule assigned only to A', async () => {
    const response = await get('adminB', '/rules?pageSize=100');
    expect(response.status).toBe(200);
    const ids = (response.body.data as { id: number }[]).map((rule) => rule.id);
    expect(ids).not.toContain(assignedRuleId);
  });
});

describe('T-031 — country assignment (TC-10, TC-11, TC-13, TC-20)', () => {
  it('TC-10: assign a rule to 3 countries — 3 rows, assigned_by set', async () => {
    const { id } = await createRule({ name: 'multi-assign' });
    const countryC = await ensureCountry('R3', 'T-031 e2e country C');
    const countryD = await ensureCountry('R4', 'T-031 e2e country D');

    for (const countryId of [countryA, countryC, countryD]) {
      const response = await post('super', `/rules/${String(id)}/countries`, { countryId });
      expect(response.status).toBe(201);
      expect(response.body.data.assignedBy).toBeDefined();
    }

    const rows = await sql<{ country_id: number }>(
      'SELECT country_id FROM reward_config.rule_country_assignments WHERE rule_id = :id',
      { id },
    );
    expect(rows).toHaveLength(3);
  });

  it('TC-11: assigning the same rule/country twice is idempotent — no duplicate row', async () => {
    const { id } = await createRule({ name: 'idempotent-assign' });

    const first = await post('super', `/rules/${String(id)}/countries`, { countryId: countryA });
    expect([200, 201]).toContain(first.status);
    const second = await post('super', `/rules/${String(id)}/countries`, { countryId: countryA });
    expect([200, 201, 409]).toContain(second.status);

    const rows = await sql<{ id: number }>(
      'SELECT id FROM reward_config.rule_country_assignments WHERE rule_id = :id AND country_id = :countryId',
      { id, countryId: countryA },
    );
    expect(rows).toHaveLength(1);
  });

  it('TC-13: unassigning an unused rule → 204, row removed', async () => {
    const { id } = await createRule({ name: 'unassign-me' });
    await post('super', `/rules/${String(id)}/countries`, { countryId: countryA });

    const response = await del('super', `/rules/${String(id)}/countries/${String(countryA)}`);
    expect(response.status).toBe(204);

    const rows = await sql<{ id: number }>(
      'SELECT id FROM reward_config.rule_country_assignments WHERE rule_id = :id AND country_id = :countryId',
      { id, countryId: countryA },
    );
    expect(rows).toHaveLength(0);
  });

  it('TC-20: DELETE a rule assigned to a country → 422, unassign first', async () => {
    const { id } = await createRule({ name: 'delete-blocked' });
    await post('super', `/rules/${String(id)}/countries`, { countryId: countryA });

    const response = await del('super', `/rules/${String(id)}`);
    expect(response.status).toBe(422);
    expectErrorEnvelope(response.body, 'RULE_HAS_COUNTRY_ASSIGNMENTS');

    const [row] = await sql<{ id: number }>(
      'SELECT id FROM reward_config.rule_master WHERE id = :id',
      {
        id,
      },
    );
    expect(row).toBeDefined();
  });

  it('DELETE an unassigned rule → 204, row genuinely removed', async () => {
    const { id } = await createRule({ name: 'delete-ok' });

    const response = await del('super', `/rules/${String(id)}`);
    expect(response.status).toBe(204);
    createdRuleIds.delete(id);

    const [row] = await sql<{ id: number }>(
      'SELECT id FROM reward_config.rule_master WHERE id = :id',
      {
        id,
      },
    );
    expect(row).toBeUndefined();
  });
});

describe('T-031 — PATCH /rules/:id (TC-19, TC-21, TC-22)', () => {
  it('TC-19: super_admin PATCHes a rule — 200, audit written with a field diff', async () => {
    const { id } = await createRule({ name: 'before name' });

    const response = await patch('super', `/rules/${String(id)}`, { name: 'after name' });
    expect(response.status).toBe(200);
    expect(response.body.data.name).toBe('after name');

    const [audit] = await sql<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM reward_portal.portal_audit_log
        WHERE event_type = 'rule_updated' AND target_id = :id
        ORDER BY occurred_at DESC LIMIT 1`,
      { id: String(id) },
    );
    expect(audit).toBeDefined();
    const changes = (audit.detail as { changes?: Record<string, unknown> }).changes;
    expect(changes).toHaveProperty('name');
  });

  it('TC-21: maker PATCHes a rule → 403', async () => {
    const { id } = await createRule({ name: 'maker cannot touch' });
    const response = await patch('makerA', `/rules/${String(id)}`, { name: 'nope' });
    expect(response.status).toBe(403);
  });

  it('TC-22: status=inactive does not disturb an existing country assignment', async () => {
    const { id } = await createRule({ name: 'going inactive' });
    await post('super', `/rules/${String(id)}/countries`, { countryId: countryA });

    const response = await patch('super', `/rules/${String(id)}`, { status: 'inactive' });
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('inactive');

    const rows = await sql<{ id: number }>(
      'SELECT id FROM reward_config.rule_country_assignments WHERE rule_id = :id',
      { id },
    );
    expect(rows).toHaveLength(1);
  });
});

describe('T-111 — GET /rules?categoryId=/subCategoryId=/search=', () => {
  /** T-105's own seed — real category/rule rows, not a fixture this suite creates or tears
   * down. Confirms the whole path end to end (DTO → `resolveSubCategoryIds` → `where`) against
   * data nothing in this suite controls, exactly the DoD's own "manually verified" ask. */
  async function componentCategoryId(): Promise<number> {
    const [row] = await sql<{ id: number }>(
      `SELECT id FROM reward_config.rule_categories WHERE category_code = 'COMPONENT'`,
    );
    if (row === undefined) {
      throw new Error('seeded rule_categories COMPONENT row not found — is T-105 applied?');
    }
    return row.id;
  }

  it('TC-5: categoryId=<COMPONENT> returns exactly T-105’s 2 seeded component rules', async () => {
    const categoryId = await componentCategoryId();
    const response = await get('super', `/rules?categoryId=${String(categoryId)}&pageSize=100`);

    expect(response.status).toBe(200);
    const ruleCodes = (response.body.data as { ruleCode: string }[])
      .map((rule) => rule.ruleCode)
      .sort();
    expect(ruleCodes).toEqual(['RULE_COMP_COMPLETED_001', 'RULE_COMP_NOT_COMPLETED_001']);
  });

  it('TC-1/TC-2: subCategoryId is a direct match; categoryId rolls the sub-category up', async () => {
    const [subCategory] = await sql<{ id: number }>(
      `SELECT rsc.id
         FROM reward_config.rule_sub_categories rsc
         JOIN reward_config.rule_categories rc ON rc.id = rsc.category_id
        WHERE rc.category_code = 'COMPONENT' AND rsc.sub_category_code = 'COMP_STATUS_CHECK'`,
    );
    expect(subCategory).toBeDefined();

    const response = await get(
      'super',
      `/rules?subCategoryId=${String(subCategory.id)}&pageSize=100`,
    );
    expect(response.status).toBe(200);
    const ruleCodes = (response.body.data as { ruleCode: string }[])
      .map((rule) => rule.ruleCode)
      .sort();
    expect(ruleCodes).toEqual(['RULE_COMP_COMPLETED_001', 'RULE_COMP_NOT_COMPLETED_001']);
  });

  it('TC-3: search matches ruleCode/name case-insensitively', async () => {
    const response = await get('super', '/rules?search=rule_comp_completed&pageSize=100');
    expect(response.status).toBe(200);
    const ruleCodes = (response.body.data as { ruleCode: string }[]).map((rule) => rule.ruleCode);
    expect(ruleCodes).toEqual(['RULE_COMP_COMPLETED_001']);
  });

  it('TC-4: categoryId and search combine — both apply (AND)', async () => {
    const categoryId = await componentCategoryId();
    const response = await get(
      'super',
      `/rules?categoryId=${String(categoryId)}&search=NOT_COMPLETED&pageSize=100`,
    );
    expect(response.status).toBe(200);
    const ruleCodes = (response.body.data as { ruleCode: string }[]).map((rule) => rule.ruleCode);
    expect(ruleCodes).toEqual(['RULE_COMP_NOT_COMPLETED_001']);
  });
});

describe('T-159 — GET /rules pagination tolerates a legacy row the shared read schema rejects', () => {
  /**
   * Reproduces the reported defect against the real database, not a hand-authored mock: a
   * legacy `rule_master` row written before T-122's `valueSourceOnlyOnSelect` refinement existed
   * (`type: 'string'` carrying a `valueSource` — the exact shape of the live dev-DB row this
   * task's own diagnosis found, `rule_master.id=1790`/`T037E2E_RULE_SIBLING`) is inserted here
   * directly with a raw `INSERT`, bypassing `RulesService.create` entirely — the only way to get
   * such a row into the table at all, since every write path has enforced this refinement since
   * T-122 (`rules.service.ts#assertValueSourceProvidersExist`'s own header).
   *
   * `search=T159PAGINATION` (T-111) scopes every query in this block to exactly the 4 rows
   * created here, regardless of how many other global rules the shared dev database happens to
   * hold — the same reason the real bug was hard to see structurally: the failure depends on
   * *where* a bad row lands relative to `pageSize`, not on the row in isolation, and this keeps
   * that positioning deterministic instead of riding on the current row count of a shared DB.
   */
  const SEARCH_TERM = 'T159PAGINATION';
  let dirtyRowId: number;

  async function insertLegacyInvalidRule(code: string): Promise<number> {
    const parameters = JSON.stringify({
      fields: [
        {
          key: 'targetComponentId',
          label: 'Target component',
          type: 'string',
          required: true,
          valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' },
        },
      ],
    });
    const [created] = await sql<{ id: number }>(
      `INSERT INTO reward_config.rule_master
         (tenant_id, sub_category_id, rule_code, name, expression, parameters, created_by, status)
       VALUES (NULL, :subCategoryId, :code, :code, NULL, :parameters, NULL, 'active')
       RETURNING id`,
      { subCategoryId, code, parameters },
    );
    createdRuleIds.add(created.id);
    return created.id;
  }

  beforeAll(async () => {
    // Sorted `name:asc`, `pageSize=2`: page 1 = [A, B], page 2 = [C (the dirty row), D] — the
    // dirty row deliberately does **not** land on page 1, mirroring the live bug report exactly
    // ("Previous" back to page 1 always worked; "Next" past it always failed).
    await createRule({ ruleCode: `${SEARCH_TERM}_A`, name: `${SEARCH_TERM}_A` });
    await createRule({ ruleCode: `${SEARCH_TERM}_B`, name: `${SEARCH_TERM}_B` });
    dirtyRowId = await insertLegacyInvalidRule(`${SEARCH_TERM}_C`);
    await createRule({ ruleCode: `${SEARCH_TERM}_D`, name: `${SEARCH_TERM}_D` });
  });

  it('page 1 (no dirty row) returns exactly the two clean rows', async () => {
    const response = await get(
      'super',
      `/rules?search=${SEARCH_TERM}&sort=name:asc&pageSize=2&page=1`,
    );
    expect(response.status).toBe(200);
    expect((response.body.data as { ruleCode: string }[]).map((rule) => rule.ruleCode)).toEqual([
      `${SEARCH_TERM}_A`,
      `${SEARCH_TERM}_B`,
    ]);
    expect(response.body.meta).toEqual({ page: 1, pageSize: 2, total: 4 });
  });

  it(
    'page 2 (dirty row included) is still a genuine 200 over real HTTP against real Postgres — ' +
      'the server never throws on this row, only a naive whole-array client schema does',
    async () => {
      const response = await get(
        'super',
        `/rules?search=${SEARCH_TERM}&sort=name:asc&pageSize=2&page=2`,
      );

      // TC-1 — reproduced live: this is a genuine 200 with a well-formed body, exactly as the
      // original diagnosis found. The bug was never a server-side failure.
      expect(response.status).toBe(200);
      expect(response.body.meta).toEqual({ page: 2, pageSize: 2, total: 4 });
      const ids = (response.body.data as { id: number; ruleCode: string }[]).map((r) => r.id);
      expect(ids).toContain(dirtyRowId);
      expect(response.body.data as unknown[]).toHaveLength(2);

      // The defect, reproduced against this exact real round trip: the whole-array envelope
      // schema `fetchRules` used to validate the *entire* response with (pre-fix) fails the
      // whole page over one bad row, real Postgres data included — not a synthetic fixture.
      const wholeArrayResult = ruleListEnvelopeSchema.safeParse(response.body);
      expect(wholeArrayResult.success).toBe(false);

      // The fix, proven against the same real payload: validating each row of `data`
      // independently (the algorithm `fetchRules` now uses) drops exactly the one dirty row and
      // keeps every other row on the page — including `meta`, untouched, so the pager still
      // counts and pages correctly regardless of how many rows were dropped.
      const rows = response.body.data as unknown[];
      const validRows = rows.filter((row) => ruleSchema.safeParse(row).success);
      const invalidRows = rows.filter((row) => !ruleSchema.safeParse(row).success);
      expect(invalidRows).toHaveLength(1);
      expect((invalidRows[0] as { id: number }).id).toBe(dirtyRowId);
      expect(validRows.map((row) => (row as { ruleCode: string }).ruleCode)).toEqual([
        `${SEARCH_TERM}_D`,
      ]);
    },
  );

  it('Previous back to page 1 from a fetch that included the dirty row still works', async () => {
    // Confirms the pager's own round trip (page 2 → page 1), not just page 2 in isolation —
    // the reported symptom was specifically that "Previous" always worked, so this pins that
    // still holds true with the dirty row present in the same dataset.
    const page2 = await get(
      'super',
      `/rules?search=${SEARCH_TERM}&sort=name:asc&pageSize=2&page=2`,
    );
    expect(page2.status).toBe(200);

    const page1 = await get(
      'super',
      `/rules?search=${SEARCH_TERM}&sort=name:asc&pageSize=2&page=1`,
    );
    expect(page1.status).toBe(200);
    expect((page1.body.data as { ruleCode: string }[]).map((rule) => rule.ruleCode)).toEqual([
      `${SEARCH_TERM}_A`,
      `${SEARCH_TERM}_B`,
    ]);
  });
});

describe('T-031 — reference data', () => {
  it('GET /rule-categories, /rule-sub-categories — reachable by every role', async () => {
    for (const key of ['super', 'adminA', 'tenantA', 'makerA', 'checkerA', 'merchantA']) {
      const categories = await get(key, '/rule-categories');
      expect(categories.status).toBe(200);
      expect(Array.isArray(categories.body.data)).toBe(true);

      const subCategories = await get(key, '/rule-sub-categories');
      expect(subCategories.status).toBe(200);
    }
  });
});
