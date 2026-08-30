/**
 * T-126 — `GET`/`POST`/`PATCH /tenants/:id/currencies` against the real Postgres instance,
 * through the real `AppModule`, over real HTTP. Same two-actor shape `rule-category-crud.
 * e2e-spec.ts` (T-106) establishes for its own `super_admin`-only writes, plus a third actor
 * (`maker`, scoped to one specific tenant) to prove the tenant-scope boundary (TC-5) a
 * single-role suite like T-106's cannot exercise — `rule_category` has no tenant column at all,
 * `tenant_currencies` is exactly the table that does.
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

const SUITE = 't126';
const PASSWORD = 'correct horse battery staple 126!';
const SUPER_ADMIN_EMAIL = 't126-e2e-super@example.invalid';
const MAKER_EMAIL = 't126-e2e-maker@example.invalid';
const CURRENCY_CODE = 'SGD';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let tenantAId: number;
let tenantBId: number;

interface Actor {
  jar: string;
  csrf: string;
}
const actors = new Map<string, Actor>();
const createdCurrencyIds: number[] = [];

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

function as(key: string): Actor {
  const actor = actors.get(key);
  if (actor === undefined) throw new Error(`no actor "${key}"`);
  return actor;
}

function get(key: string, path: string) {
  return http().get(`/api/v1${path}`).set('Cookie', as(key).jar);
}

function post(key: string, path: string, body: unknown) {
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

async function makeActor(
  key: string,
  email: string,
  role: string,
  scope: { countryId: number | null; tenantId: number | null; merchantId: number | null } = {
    countryId: null,
    tenantId: null,
    merchantId: null,
  },
): Promise<void> {
  await deletePortalUsersByEmail(db, emailCrypto, [email]);
  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-126 ${key}`,
    role,
    ...scope,
    mustChangePassword: false,
  });
  await db.query(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { replacements: { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) } },
  );
  const response = await loginCompletingMfa(app, { email, password: PASSWORD }, db);
  if (response.status !== 200) {
    throw new Error(`login for ${key} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  actors.set(key, { jar: jarFrom(response), csrf: cookieValue(response, CSRF_COOKIE_NAME) });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  await app.init();

  db = app.get<Sequelize>(SEQUELIZE);
  await ensureEncryptionKeys(db, SUITE);
  emailCrypto = emailCryptoOf(app);

  const tenants = await db.query<{ id: number; countryId: number }>(
    `SELECT id, country_id AS "countryId" FROM reward_config.tenants ORDER BY id LIMIT 2`,
    { type: QueryTypes.SELECT },
  );
  if (tenants.length < 2) throw new Error('T-126 e2e requires at least two existing tenants');
  tenantAId = tenants[0].id;
  tenantBId = tenants[1].id;

  await makeActor('super', SUPER_ADMIN_EMAIL, 'super_admin');
  await makeActor('maker', MAKER_EMAIL, 'maker', {
    countryId: tenants[0].countryId,
    tenantId: tenantAId,
    merchantId: null,
  });
});

afterAll(async () => {
  if (createdCurrencyIds.length > 0) {
    await db.query(
      `DELETE FROM reward_config.tenant_currencies WHERE id IN (${createdCurrencyIds.join(',')})`,
      { type: QueryTypes.RAW },
    );
  }
  await deletePortalUsersByEmail(db, emailCrypto, [SUPER_ADMIN_EMAIL, MAKER_EMAIL]);
  await removeEncryptionKeys(db, SUITE);
  await app.close();
});

describe('T-126 — GET /tenants/:id/currencies', () => {
  it('verification step 2 / TC-4: a role scoped to the tenant sees at least the backfilled default', async () => {
    const res = await get('maker', `/tenants/${tenantAId}/currencies`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.some((row: { isDefault: boolean }) => row.isDefault)).toBe(true);
  });

  it('super_admin may read any tenant’s currencies', async () => {
    const res = await get('super', `/tenants/${tenantAId}/currencies`);
    expect(res.status).toBe(200);
  });

  it('TC-5: a maker scoped to tenant A gets 404 for tenant B’s currencies', async () => {
    const res = await get('maker', `/tenants/${tenantBId}/currencies`);
    expect(res.status).toBe(404);
  });

  it('unauthenticated — 401', async () => {
    const res = await http().get(`/api/v1/tenants/${tenantAId}/currencies`);
    expect(res.status).toBe(401);
  });
});

describe('T-126 — POST /tenants/:id/currencies', () => {
  it('TC-2: super_admin adds a second currency — 201, isDefault: false', async () => {
    const res = await post('super', `/tenants/${tenantAId}/currencies`, {
      currencyCode: CURRENCY_CODE,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      tenantId: tenantAId,
      currencyCode: CURRENCY_CODE,
      isDefault: false,
      status: 'active',
    });
    createdCurrencyIds.push(res.body.data.id);

    const list = await get('super', `/tenants/${tenantAId}/currencies`);
    expect(
      (list.body.data as Array<{ currencyCode: string }>).some(
        (row) => row.currencyCode === CURRENCY_CODE,
      ),
    ).toBe(true);
  });

  it('TC-3: a second is_default row for the same tenant — 409', async () => {
    const res = await post('super', `/tenants/${tenantAId}/currencies`, {
      currencyCode: 'AUD',
      isDefault: true,
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('TENANT_CURRENCY_DEFAULT_EXISTS');
  });

  it('a repeat of the same currencyCode for the same tenant — 409', async () => {
    const res = await post('super', `/tenants/${tenantAId}/currencies`, {
      currencyCode: CURRENCY_CODE,
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('TENANT_CURRENCY_EXISTS');
  });

  it('TC-6: a non-super_admin gets 403, and no row is written', async () => {
    const res = await post('maker', `/tenants/${tenantAId}/currencies`, {
      currencyCode: 'THB',
    });
    expect(res.status).toBe(403);

    const [{ count }] = await db.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM reward_config.tenant_currencies
        WHERE tenant_id = ${tenantAId} AND currency_code = 'THB'`,
      { type: QueryTypes.SELECT },
    );
    expect(Number(count)).toBe(0);
  });

  it('a tenant id outside any scope at all — 404', async () => {
    const res = await post('super', `/tenants/999999999/currencies`, { currencyCode: 'XYZ' });
    expect(res.status).toBe(404);
  });

  it('unauthenticated — 401', async () => {
    const res = await http()
      .post(`/api/v1/tenants/${tenantAId}/currencies`)
      .send({ currencyCode: 'XYZ' });
    expect(res.status).toBe(401);
  });
});

describe('T-126 — PATCH /tenants/:id/currencies/:currencyId', () => {
  it("super_admin retires a currency — 200, status: 'inactive'", async () => {
    const currencyId = createdCurrencyIds[0];
    const res = await patch('super', `/tenants/${tenantAId}/currencies/${currencyId}`, {
      status: 'inactive',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('inactive');
  });

  it('a non-super_admin gets 403', async () => {
    const currencyId = createdCurrencyIds[0];
    const res = await patch('maker', `/tenants/${tenantAId}/currencies/${currencyId}`, {
      status: 'active',
    });
    expect(res.status).toBe(403);
  });

  it('a currencyId that belongs to a different tenant — 404', async () => {
    const currencyId = createdCurrencyIds[0];
    const res = await patch('super', `/tenants/${tenantBId}/currencies/${currencyId}`, {
      status: 'active',
    });
    expect(res.status).toBe(404);
  });
});
