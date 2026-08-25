/**
 * T-059 — `POST /tenants` and `POST /tenants/:id/admins` against the **real** Postgres instance,
 * through the real `AppModule`, over real HTTP. Follows the harness `test/access-control/
 * access-control.e2e-spec.ts` (T-033) and `test/rules/rules.e2e-spec.ts` (T-031) both establish.
 *
 * This is the "real test, not reasoning" half the task file's own Definition of Done calls for on
 * TC-4/TC-5 (transaction integrity): `tenants.service.spec.ts`'s unit tests prove the *shape* of
 * the fix (the credential insert is routed through `CredentialProvisioner`, in the same
 * transaction, and a failure there is not swallowed), but only a real `sequelize.transaction()`
 * against real Postgres can prove the rollback itself actually happens — a `FakeSequelize`'s
 * `.transaction()` never rolls anything back, so no amount of unit testing could catch a defect in
 * *that* mechanism. `tenants`/`countries`/`users`/`merchants` had no e2e suite of their own before
 * this task; this file is scoped narrowly to what T-059 itself needs proof of, not a general
 * `/tenants` regression suite (that gap is pre-existing and unrelated — flagged in this task's
 * completion report, not silently expanded here).
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

const T059_SUITE = 't059';
const PASSWORD = 'correct horse battery staple 7!';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let countryId: number;

interface Actor {
  readonly email: string;
  readonly userId: number;
  readonly jar: string;
  readonly csrf: string;
}

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

async function makeCountryAdmin(key: string): Promise<Actor> {
  const email = `t059-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-059 ${key}`,
    role: 'country_admin',
    countryId,
    tenantId: null,
    merchantId: null,
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

  return {
    email,
    userId,
    jar: jarFrom(response),
    csrf: cookieValue(response, CSRF_COOKIE_NAME),
  };
}

function post(actor: Actor, path: string, body: unknown = {}) {
  return http()
    .post(`/api/v1${path}`)
    .set('Cookie', actor.jar)
    .set('X-CSRF-Token', actor.csrf)
    .send(body as object);
}

async function ensureCountry(code: string, name: string): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries WHERE code = :code',
    { code },
  );
  if (existing !== undefined) return existing.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
     VALUES (:code, :name, 'UTC', 'USD', '+001', 'active') RETURNING id`,
    { code, name },
  );
  return created.id;
}

const fixtureTenantCodes: string[] = [];
const fixtureUserEmails: string[] = [];

async function cleanupTenant(code: string): Promise<void> {
  await exec(
    `DELETE FROM reward_portal.portal_user_credentials
      WHERE user_id IN (
        SELECT id FROM reward_portal.portal_users
         WHERE tenant_id = (SELECT id FROM reward_config.tenants WHERE code = :code)
      )`,
    { code },
  );
  await exec(
    `DELETE FROM reward_portal.portal_users
      WHERE tenant_id = (SELECT id FROM reward_config.tenants WHERE code = :code)`,
    { code },
  );
  await exec(`DELETE FROM reward_config.tenants WHERE code = :code`, { code });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), T059_SUITE);

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

  // Same `CHAR(2)`-shaped code discipline `access-control.e2e-spec.ts` documents (T-033 retry 1) —
  // 'T9' is not used by any other suite.
  countryId = await ensureCountry('T9', 'T-059 e2e country');
});

afterAll(async () => {
  try {
    for (const code of fixtureTenantCodes) {
      await cleanupTenant(code);
    }
    if (fixtureUserEmails.length > 0) {
      await deletePortalUsersByEmail(db, emailCrypto, fixtureUserEmails);
    }
    await removeEncryptionKeys(db, T059_SUITE);
  } finally {
    if (app !== undefined) await app.close();
  }
});

describe('T-059 — POST /tenants with a nested admin (TC-2, TC-3, TC-4)', () => {
  it('a country_admin can onboard a tenant with its Tenant Admin in one call, and the admin can log in', async () => {
    const countryAdmin = await makeCountryAdmin('provision-1');
    fixtureUserEmails.push(countryAdmin.email);

    const tenantCode = 'T059A';
    fixtureTenantCodes.push(tenantCode);
    const adminEmail = 't059-e2e-tenant-admin-1@example.invalid';
    fixtureUserEmails.push(adminEmail);

    // TC-2/TC-4: before the fix, this always failed — `provisionTenantAdmin` called
    // `scoped.create(PortalUserCredential, …)`, which `scope-strategy.ts` denies for
    // `country_admin`, so the whole transaction threw `ScopeViolationError` and the endpoint
    // never returned 200/201 for its primary actor.
    const response = await post(countryAdmin, '/tenants', {
      code: tenantCode,
      name: 'T-059 E2E Tenant',
      admin: { email: adminEmail, displayName: 'T-059 E2E Tenant Admin' },
    });

    expect(response.status).toBe(201);
    // New tenants are created `pending_provisioning` (activated separately via
    // `POST /tenants/:id/activate`) — unrelated to this task's fix, just the existing, correct
    // behaviour this test must not misdescribe.
    expect(response.body.data.tenant).toMatchObject({
      code: tenantCode,
      status: 'pending_provisioning',
    });
    expect(response.body.data.admin).toMatchObject({
      email: adminEmail,
      role: 'tenant_admin',
      tenantId: response.body.data.tenant.id,
    });
    const temporaryPassword: string = response.body.data.admin.temporaryPassword;
    expect(typeof temporaryPassword).toBe('string');
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(20);

    // Verification step 3 — exactly one portal_users row and exactly one
    // portal_user_credentials row for the new admin, proven live against the real database,
    // not reasoned about from a fake.
    const userId: number = response.body.data.admin.id;
    const [userRow] = await sql<{ count: string }>(
      'SELECT count(*)::int AS count FROM reward_portal.portal_users WHERE id = :userId',
      { userId },
    );
    const [credentialRow] = await sql<{ count: string }>(
      'SELECT count(*)::int AS count FROM reward_portal.portal_user_credentials WHERE user_id = :userId',
      { userId },
    );
    expect(Number(userRow.count)).toBe(1);
    expect(Number(credentialRow.count)).toBe(1);

    // TC-3 — the new tenant admin logs in with the issued password.
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: temporaryPassword });

    expect(login.status).toBe(200);
    expect(login.body.data.mustChangePassword).toBe(true);
    expect(login.body.data.role).toBe('tenant_admin');
  });

  it('a duplicate admin email still maps to 409 TENANT_ADMIN_EMAIL_EXISTS, not a raw constraint error (TC-7)', async () => {
    const countryAdmin = await makeCountryAdmin('provision-dup');
    fixtureUserEmails.push(countryAdmin.email);

    const tenantCode = 'T059B';
    fixtureTenantCodes.push(tenantCode);
    const adminEmail = 't059-e2e-tenant-admin-dup@example.invalid';
    fixtureUserEmails.push(adminEmail);

    const first = await post(countryAdmin, '/tenants', {
      code: tenantCode,
      name: 'T-059 E2E Tenant Dup',
      admin: { email: adminEmail, displayName: 'First' },
    });
    expect(first.status).toBe(201);

    const secondTenantCode = 'T059C';
    fixtureTenantCodes.push(secondTenantCode);
    const second = await post(countryAdmin, '/tenants', {
      code: secondTenantCode,
      name: 'T-059 E2E Tenant Dup 2',
      admin: { email: adminEmail, displayName: 'Second' },
    });

    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe('TENANT_ADMIN_EMAIL_EXISTS');

    // The second tenant itself must not have been left half-created either — same one
    // transaction, same rollback guarantee TC-4 asserts for the user/credential pair.
    const [tenantRow] = await sql<{ count: string }>(
      'SELECT count(*)::int AS count FROM reward_config.tenants WHERE code = :code',
      { code: secondTenantCode },
    );
    expect(Number(tenantRow.count)).toBe(0);
  });
});

describe('T-059 — negative authorisation (R6)', () => {
  it('a non-country_admin gets 403, and the transaction never opens', async () => {
    const email = 't059-e2e-super-admin-actor@example.invalid';
    await deletePortalUsersByEmail(db, emailCrypto, [email]);
    // `super_admin` — deliberately, not `tenant_admin`: `ck_portal_users_scope` requires a
    // `tenant_admin` row to already carry a `tenant_id`, which would need a tenant fixture just
    // to set up a negative test. `assertRole(actor, 'country_admin')` denies `super_admin` for
    // exactly the same reason it denies every other non-`country_admin` role (`tenants.service.
    // ts`'s own header, "TC-6, TC-9: tenant_admin and super_admin are each denied here"), so this
    // proves the same boundary with a scope-constraint-free role.
    const userId = await insertPortalUser(db, emailCrypto, {
      email,
      displayName: 'T-059 super_admin actor',
      role: 'super_admin',
      countryId: null,
      tenantId: null,
      merchantId: null,
      mustChangePassword: false,
    });
    fixtureUserEmails.push(email);
    await exec(
      `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
       VALUES (:userId, :hash, 'argon2id')`,
      { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
    );
    const login = await loginCompletingMfa(app, { email, password: PASSWORD }, db);
    if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
    const actor: Actor = {
      email,
      userId,
      jar: jarFrom(login),
      csrf: cookieValue(login, CSRF_COOKIE_NAME),
    };

    const response = await post(actor, '/tenants', {
      code: 'T059D',
      name: 'Should never exist',
      admin: { email: 'never@example.invalid', displayName: 'Never' },
    });

    expect(response.status).toBe(403);
    const [tenantRow] = await sql<{ count: string }>(
      "SELECT count(*)::int AS count FROM reward_config.tenants WHERE code = 'T059D'",
    );
    expect(Number(tenantRow.count)).toBe(0);
  });

  it('a country_admin from a different tenant onboarding onto an unknown/out-of-scope tenant id gets 404', async () => {
    const countryAdmin = await makeCountryAdmin('provision-404');
    fixtureUserEmails.push(countryAdmin.email);

    const response = await post(countryAdmin, '/tenants/999999999/admins', {
      email: 'never-either@example.invalid',
      displayName: 'Never Either',
    });

    expect(response.status).toBe(404);
  });
});
