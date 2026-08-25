/**
 * T-101 — `POST /users` against the **real** Postgres instance, through the real `AppModule`,
 * over real HTTP, with real encryption hooks installed.
 *
 * The defect this file exists to prove/disprove is specific to something a mocked unit test
 * structurally cannot observe: `PortalUser.email` only decrypts through Sequelize's `afterFind`
 * hook (`model-encryption.hooks.ts`), which a `FakeScopedRepository` in `users.service.spec.ts`
 * does not run at all — that suite's own T-101 test proves the *service's control flow* (reload
 * before responding), not that a real `afterFind` actually fires and actually decrypts. Per
 * AGENT-PROTOCOL.md §3 ("assert the observable property … in a client that actually enforces the
 * rules"), and the T-011/T-058 precedent it cites for exactly this failure mode (full unit/HTTP/
 * e2e coverage green while the real mechanism silently did the wrong thing), this suite is the
 * one that judges the actual property: does `POST /users`'s HTTP response carry the typed email
 * address, and does the row Postgres actually stores stay ciphertext throughout.
 *
 * Follows the harness `test/tenants/tenants.e2e-spec.ts` (T-059) and `test/auth/support/
 * portal-user-fixture.ts` (T-056) both establish for an encrypted-email suite.
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
import { looksLikeCiphertext } from '@/common/crypto';
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

const T101_SUITE = 't101';
const PASSWORD = 'correct horse battery staple 7!';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let countryId: number;
let tenantId: number;

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

async function ensureTenant(code: string, name: string, forCountryId: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.tenants WHERE code = :code',
    { code },
  );
  if (existing !== undefined) return existing.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :name, :countryId, 'active') RETURNING id`,
    { code, name, countryId: forCountryId },
  );
  return created.id;
}

const fixtureUserEmails: string[] = [];

async function makeTenantAdmin(key: string): Promise<Actor> {
  const email = `t101-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-101 ${key}`,
    role: 'tenant_admin',
    countryId,
    tenantId,
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

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), T101_SUITE);

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

  // 'T1' — not used by any other suite's fixture country (same `CHAR(2)` discipline
  // `access-control.e2e-spec.ts` documents, T-033 retry 1).
  countryId = await ensureCountry('T1', 'T-101 e2e country');
  tenantId = await ensureTenant('T101TEN', 'T-101 e2e tenant', countryId);
});

afterAll(async () => {
  try {
    if (fixtureUserEmails.length > 0) {
      await deletePortalUsersByEmail(db, emailCrypto, fixtureUserEmails);
    }
    await removeEncryptionKeys(db, T101_SUITE);
  } finally {
    if (app !== undefined) await app.close();
  }
});

describe("T-101 — POST /users returns the typed email address, not portal_users.email's raw ciphertext", () => {
  it('TC-1/TC-2/TC-3: the response body carries the plaintext email, and the stored row is genuinely ciphertext', async () => {
    const tenantAdmin = await makeTenantAdmin('actor-1');
    fixtureUserEmails.push(tenantAdmin.email);

    const newUserEmail = 't101-e2e-new-maker-1@example.invalid';
    fixtureUserEmails.push(newUserEmail);

    const response = await post(tenantAdmin, '/users', {
      email: newUserEmail,
      displayName: 'T-101 E2E Maker',
      role: 'maker',
    });

    expect(response.status).toBe(201);

    // TC-1/TC-2 — this is the exact property that was broken: before the fix, `data.email` was
    // `scoped.create()`'s raw post-INSERT value, an unparsed `v1.<kid>.<iv>.<tag>.<ct>` envelope,
    // not the address the request typed in.
    expect(response.body.data.email).toBe(newUserEmail);
    expect(looksLikeCiphertext(response.body.data.email)).toBe(false);
    expect(typeof response.body.data.temporaryPassword).toBe('string');
    expect(response.body.data.temporaryPassword.length).toBeGreaterThanOrEqual(20);

    // TC-3 — the row Postgres actually holds must still be ciphertext, bound to its own id: the
    // fix is "decrypt on the way out", never "stop encrypting at rest".
    const userId: number = response.body.data.id;
    const [rawRow] = await sql<{ email: string }>(
      'SELECT email FROM reward_portal.portal_users WHERE id = :userId',
      { userId },
    );
    expect(looksLikeCiphertext(rawRow.email)).toBe(true);
    expect(rawRow.email).not.toBe(newUserEmail);

    // Adjacent behaviour (TC-4) that must not change: the issued password logs the new user in,
    // and *that* path's own reload (`findByPkOrFail` on login) already decrypted correctly before
    // this fix — proving this fix did not regress it.
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: newUserEmail, password: response.body.data.temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.data.role).toBe('maker');
  });

  it('TC-4: POST /users/:id/reset-password was already correct, and stays correct — the reload-before-respond fix does not touch it', async () => {
    const tenantAdmin = await makeTenantAdmin('actor-2');
    fixtureUserEmails.push(tenantAdmin.email);

    const targetEmail = 't101-e2e-reset-target-1@example.invalid';
    fixtureUserEmails.push(targetEmail);

    const created = await post(tenantAdmin, '/users', {
      email: targetEmail,
      displayName: 'T-101 E2E Reset Target',
      role: 'maker',
    });
    expect(created.status).toBe(201);
    const targetId: number = created.body.data.id;

    const reset = await post(tenantAdmin, `/users/${String(targetId)}/reset-password`);

    expect(reset.status).toBe(201);
    expect(reset.body.data.email).toBe(targetEmail);
    expect(looksLikeCiphertext(reset.body.data.email)).toBe(false);
  });
});
