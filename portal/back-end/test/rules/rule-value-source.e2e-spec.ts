/**
 * T-122 — a rule parameter field's `valueSource`, against the **real** Postgres instance, through
 * the real `AppModule`, over real HTTP, as a real `super_admin`.
 *
 * ### Why this suite exists rather than unit tests alone
 *
 * `AGENT-PROTOCOL §3`: *"Ask of each security-critical test: if the specified value were wrong,
 * would this test still pass?"* Two of this task's six cases cannot honestly be answered by the
 * unit doubles:
 *
 * - **TC-5 (a `planned` provider is accepted).** `FakeScopedRepository.listAll` ignores the `where`
 *   clause it is handed, so a `status: 'active'` filter wrongly added to the registry lookup would
 *   change nothing there — the double would return the row either way and the test would still
 *   pass. Here the filter would be applied by Postgres against the genuinely `planned`
 *   `PRODUCT_CATALOG` row T121_002 seeds, and this suite would go red. That is the difference
 *   between a change-detector and a test.
 * - **TC-4 (an unknown provider is refused).** The unit test proves the service throws; only a
 *   real request proves that throw surfaces as a 400 through `ErrorNormalizationFilter` with its
 *   `details` intact rather than being flattened into a bare 500.
 *
 * Follows the harness `rule-parameter-roles.e2e-spec.ts` (T-114) establishes — real login through
 * MFA, real cookies, real guards, real `ScopedRepository` — and creates its own rules rather than
 * mutating a seeded one, so nothing outside `createdRuleIds` is touched.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { AppModule } from '@/app.module';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
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

jest.setTimeout(300_000);

const SUITE = 't122';
const PASSWORD = 'correct horse battery staple 22!';
const SUPER_ADMIN_EMAIL = 't122-e2e-super@example.invalid';
const RULE_CODE_PREFIX = 'T122E2E';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let jar: string;
let csrf: string;
let subCategoryId: number;

const createdRuleIds: number[] = [];
let ruleCodeCounter = 0;

function http() {
  return request(app.getHttpServer());
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

/** `POST /rules` with a fresh, collision-proof `ruleCode`, remembering anything created so
 * `afterAll` can remove it. */
async function postRule(fields: unknown[]): Promise<request.Response> {
  ruleCodeCounter += 1;
  const response = await http()
    .post('/api/v1/rules')
    .set('Cookie', jar)
    .set('x-csrf-token', csrf)
    .send({
      ruleCode: `${RULE_CODE_PREFIX}_${String(ruleCodeCounter)}`,
      name: `T-122 value source ${String(ruleCodeCounter)}`,
      subCategoryId,
      parameters: { fields },
    });
  if (response.status === 201) createdRuleIds.push(response.body.data.id as number);
  return response;
}

function selectField(overrides: Record<string, unknown> = {}) {
  return {
    key: 'targetComponentCode',
    label: 'Target component',
    type: 'select',
    required: true,
    ...overrides,
  };
}

const CONTEXT_SOURCE = { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' };
const PLANNED_API_SOURCE = { kind: 'API_LOOKUP', apiProvider: 'PRODUCT_CATALOG' };

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  await app.init();

  db = app.get<Sequelize>(SEQUELIZE);
  await ensureEncryptionKeys(db, SUITE);
  emailCrypto = emailCryptoOf(app);

  // The registry rows this suite's assertions rest on. Asserted rather than assumed: if T121_002
  // ever changes `PRODUCT_CATALOG` to `active`, TC-5 would silently stop testing anything, so it
  // must fail loudly here instead.
  const [siblingComponents] = await db.query<{ status: string }>(
    `SELECT status FROM reward_config.field_context_providers WHERE provider_code = 'SIBLING_COMPONENTS'`,
    { type: QueryTypes.SELECT },
  );
  const [productCatalog] = await db.query<{ status: string }>(
    `SELECT status FROM reward_config.field_api_lookup_providers WHERE provider_code = 'PRODUCT_CATALOG'`,
    { type: QueryTypes.SELECT },
  );
  if (siblingComponents === undefined || productCatalog === undefined) {
    throw new Error('t122 e2e: T-121 seeded providers not found — did T121_002 run?');
  }
  if (productCatalog.status !== 'planned') {
    throw new Error(
      `t122 e2e: PRODUCT_CATALOG is '${productCatalog.status}', not 'planned' — TC-5 would no ` +
        'longer prove that a planned provider is accepted. Pick another planned provider.',
    );
  }

  const [subCategory] = await db.query<{ id: number }>(
    `SELECT id FROM reward_config.rule_sub_categories ORDER BY id LIMIT 1`,
    { type: QueryTypes.SELECT },
  );
  if (subCategory === undefined) throw new Error('t122 e2e: no rule_sub_categories row');
  subCategoryId = subCategory.id;

  await deletePortalUsersByEmail(db, emailCrypto, [SUPER_ADMIN_EMAIL]);
  const userId = await insertPortalUser(db, emailCrypto, {
    email: SUPER_ADMIN_EMAIL,
    displayName: 'T-122 super_admin',
    role: 'super_admin',
    countryId: null,
    tenantId: null,
    merchantId: null,
    mustChangePassword: false,
  });
  await db.query(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { replacements: { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) } },
  );

  const response = await loginCompletingMfa(
    app,
    { email: SUPER_ADMIN_EMAIL, password: PASSWORD },
    db,
  );
  if (response.status !== 200) {
    throw new Error(`login failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  jar = jarFrom(response);
  csrf = cookieValue(response, CSRF_COOKIE_NAME);
});

afterAll(async () => {
  for (const id of createdRuleIds) {
    await db.query(`DELETE FROM reward_config.rule_master WHERE id = :id`, {
      type: QueryTypes.RAW,
      replacements: { id },
    });
  }
  await deletePortalUsersByEmail(db, emailCrypto, [SUPER_ADMIN_EMAIL]);
  await removeEncryptionKeys(db, SUITE);
  await app.close();
});

describe('T-122 — POST /rules with a value-sourced parameter field', () => {
  it('TC-1: a select field with options and no valueSource — 201, unchanged behaviour', async () => {
    const response = await postRule([
      selectField({ key: 'tier', label: 'Tier', options: ['gold', 'silver'] }),
    ]);
    expect(response.status).toBe(201);
  });

  it('TC-2 / Verification 1: a select field sourced from SIBLING_COMPONENTS — 201, and it round-trips', async () => {
    const response = await postRule([selectField({ valueSource: CONTEXT_SOURCE })]);
    expect(response.status).toBe(201);

    // Read it back through the API rather than trusting the create response: `parameters` is a
    // `text` column holding JSON, so this proves the value survived the write/parse round trip.
    const read = await http().get(`/api/v1/rules/${response.body.data.id}`).set('Cookie', jar);
    expect(read.status).toBe(200);
    const [field] = read.body.data.parameters.fields as Array<Record<string, unknown>>;
    expect(field.valueSource).toEqual(CONTEXT_SOURCE);
  });

  it('TC-3: a select field with neither options nor valueSource — 400', async () => {
    const response = await postRule([selectField({ key: 'tier', label: 'Tier' })]);
    expect(response.status).toBe(400);
  });

  it('TC-4 / Verification 2: a made-up provider code — 400 naming the field', async () => {
    const response = await postRule([
      selectField({
        valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'NOT_A_REAL_PROVIDER' },
      }),
    ]);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('UNKNOWN_FIELD_VALUE_SOURCE_PROVIDER');
    expect(response.body.error.details).toEqual([
      { field: 'parameters.targetComponentCode', code: 'PROVIDER_NOT_A_REAL_PROVIDER' },
    ]);
  });

  it('TC-4: a real *context* provider code used as an API provider is still unknown', async () => {
    // `SIBLING_COMPONENTS` exists — but in the other registry. Each kind must be checked against
    // its own table, not against "any provider anywhere".
    const response = await postRule([
      selectField({
        key: 'productId',
        valueSource: { kind: 'API_LOOKUP', apiProvider: 'SIBLING_COMPONENTS' },
      }),
    ]);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('UNKNOWN_FIELD_VALUE_SOURCE_PROVIDER');
  });

  it('TC-5: a real provider whose status is planned — 201, authoring is not blocked on it', async () => {
    const response = await postRule([
      selectField({ key: 'productId', label: 'Product', valueSource: PLANNED_API_SOURCE }),
    ]);
    expect(response.status).toBe(201);
  });

  it('TC-6: a string field carrying a valueSource — 400, only select fields may have one', async () => {
    const response = await postRule([selectField({ type: 'string', valueSource: CONTEXT_SOURCE })]);
    expect(response.status).toBe(400);
  });
});

describe('T-122 — PATCH /rules/:id is gated the same way', () => {
  let ruleId: number;

  beforeAll(async () => {
    const created = await postRule([
      selectField({ key: 'tier', label: 'Tier', options: ['gold'] }),
    ]);
    expect(created.status).toBe(201);
    ruleId = created.body.data.id as number;
  });

  async function patchParameters(fields: unknown[]): Promise<request.Response> {
    return http()
      .patch(`/api/v1/rules/${ruleId}`)
      .set('Cookie', jar)
      .set('x-csrf-token', csrf)
      .send({ parameters: { fields } });
  }

  it('accepts an edit to a known provider — 200', async () => {
    const response = await patchParameters([selectField({ valueSource: CONTEXT_SOURCE })]);
    expect(response.status).toBe(200);
  });

  it('refuses an edit to an unknown provider — 400, and the stored parameters are unchanged', async () => {
    const response = await patchParameters([
      selectField({ valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'STILL_NOT_REAL' } }),
    ]);
    expect(response.status).toBe(400);

    const read = await http().get(`/api/v1/rules/${ruleId}`).set('Cookie', jar);
    const [field] = read.body.data.parameters.fields as Array<Record<string, unknown>>;
    expect(field.valueSource).toEqual(CONTEXT_SOURCE);
  });
});
