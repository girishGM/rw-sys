/**
 * T-106 — `POST`/`PATCH /rule-categories`, `/rule-sub-categories` against the real Postgres
 * instance, through the real `AppModule`, over real HTTP. Two actors: `super_admin` (the only
 * role permitted to write) and `maker` (proves the permission gate actually rejects everyone
 * else), mirroring `rules.e2e-spec.ts`'s own two-actor shape for `POST /rules`.
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

const SUITE = 't106';
const PASSWORD = 'correct horse battery staple 11!';
const SUPER_ADMIN_EMAIL = 't106-e2e-super@example.invalid';
const MAKER_EMAIL = 't106-e2e-maker@example.invalid';
const CATEGORY_CODE = `T106_CAT_${Date.now()}`;
const SUB_CATEGORY_CODE = `T106_SUB_${Date.now()}`;

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

interface Actor {
  jar: string;
  csrf: string;
}
const actors = new Map<string, Actor>();
const createdCategoryIds: number[] = [];

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
    displayName: `T-106 ${key}`,
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
      exceptionFactory: validationExceptionFactory,
    }),
  );
  await app.init();

  db = app.get<Sequelize>(SEQUELIZE);
  await ensureEncryptionKeys(db, SUITE);
  emailCrypto = emailCryptoOf(app);

  const [{ id: tenantId, countryId }] = await db.query<{ id: number; countryId: number }>(
    `SELECT id, country_id AS "countryId" FROM reward_config.tenants LIMIT 1`,
    { type: QueryTypes.SELECT },
  );

  await makeActor('super', SUPER_ADMIN_EMAIL, 'super_admin');
  await makeActor('maker', MAKER_EMAIL, 'maker', { countryId, tenantId, merchantId: null });
});

afterAll(async () => {
  for (const id of createdCategoryIds) {
    await db.query(`DELETE FROM reward_config.rule_sub_categories WHERE category_id = :id`, {
      type: QueryTypes.RAW,
      replacements: { id },
    });
    await db.query(`DELETE FROM reward_config.rule_categories WHERE id = :id`, {
      type: QueryTypes.RAW,
      replacements: { id },
    });
  }
  await deletePortalUsersByEmail(db, emailCrypto, [SUPER_ADMIN_EMAIL, MAKER_EMAIL]);
  await removeEncryptionKeys(db, SUITE);
  await app.close();
});

describe('T-106 — rule category & sub-category CRUD', () => {
  let categoryId: number;

  it('TC-1: super_admin creates a category — 201, visible via GET', async () => {
    const res = await post('super', '/rule-categories', {
      categoryCode: CATEGORY_CODE,
      name: 'T-106 E2E Category',
    });
    expect(res.status).toBe(201);
    categoryId = res.body.data.id as number;
    createdCategoryIds.push(categoryId);

    const list = await http().get('/api/v1/rule-categories').set('Cookie', as('super').jar);
    expect(
      (list.body.data as Array<{ categoryCode: string }>).some(
        (c) => c.categoryCode === CATEGORY_CODE,
      ),
    ).toBe(true);
  });

  it('TC-2: non-super_admin creates a category — 403', async () => {
    const res = await post('maker', '/rule-categories', {
      categoryCode: `${CATEGORY_CODE}_X`,
      name: 'Should be rejected',
    });
    expect(res.status).toBe(403);
  });

  it('TC-3: duplicate categoryCode — 409', async () => {
    const res = await post('super', '/rule-categories', {
      categoryCode: CATEGORY_CODE,
      name: 'Duplicate attempt',
    });
    expect(res.status).toBe(409);
  });

  it('TC-4: super_admin creates a sub-category under a real category — 201', async () => {
    const res = await post('super', '/rule-sub-categories', {
      categoryId,
      subCategoryCode: SUB_CATEGORY_CODE,
      name: 'T-106 E2E Sub-Category',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.categoryId).toBe(categoryId);
  });

  it('TC-5: sub-category with a nonexistent categoryId — 404', async () => {
    const res = await post('super', '/rule-sub-categories', {
      categoryId: 999_999_999,
      subCategoryCode: 'SHOULD_FAIL',
      name: 'Nonexistent parent',
    });
    expect([400, 404]).toContain(res.status);
  });

  it("TC-6: PATCH a category's name/status", async () => {
    const res = await patch('super', `/rule-categories/${categoryId}`, {
      name: 'T-106 E2E Category (renamed)',
      status: 'inactive',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('T-106 E2E Category (renamed)');
    expect(res.body.data.status).toBe('inactive');
  });

  it('TC-7: unauthenticated — 401', async () => {
    const res = await http().post('/api/v1/rule-categories').send({ categoryCode: 'X', name: 'X' });
    expect(res.status).toBe(401);
  });
});
