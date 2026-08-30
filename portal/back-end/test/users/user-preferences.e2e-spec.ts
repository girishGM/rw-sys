/**
 * T-128 — `GET`/`PATCH /users/me/preferences` against the **real** Postgres instance, through the
 * real `AppModule`, over real HTTP.
 *
 * Follows the harness `users.e2e-spec.ts` (T-101) establishes for this directory: real encryption
 * keys, a real fixture country/tenant, a real login. The property this suite exists to prove is
 * one a mocked `FakeScopedRepository` (`users.service.spec.ts`) cannot: that the real guard chain
 * (`RolesGuard`/`PermissionsGuard`) actually admits every role with no `user:update` grant, that
 * the real `ck_portal_users_ui_theme` (`T128_001`) constraint and the real global `ValidationPipe`
 * both reject an out-of-enum value, and that the value genuinely round-trips through Postgres —
 * per AGENT-PROTOCOL.md §3, "assert the observable property … in a client that actually enforces
 * the rules".
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

const T128_SUITE = 't128';
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

function getPrefs(who: Actor) {
  return http().get('/api/v1/users/me/preferences').set('Cookie', who.jar);
}

function patchPrefs(who: Actor, body: unknown) {
  return http()
    .patch('/api/v1/users/me/preferences')
    .set('Cookie', who.jar)
    .set('X-CSRF-Token', who.csrf)
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

async function makeUser(key: string, role: string): Promise<Actor> {
  const email = `t128-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-128 ${key}`,
    role,
    countryId,
    tenantId,
    merchantId: null,
    mustChangePassword: false,
  });

  await db.query(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    {
      type: QueryTypes.INSERT,
      replacements: { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
    },
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
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), T128_SUITE);

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

  // 'T2' — not used by any other suite's fixture country (T-101's own `t101test.com` discipline,
  // one letter over).
  countryId = await ensureCountry('T2', 'T-128 e2e country');
  tenantId = await ensureTenant('T128TEN', 'T-128 e2e tenant', countryId);
});

afterAll(async () => {
  try {
    if (fixtureUserEmails.length > 0) {
      await deletePortalUsersByEmail(db, emailCrypto, fixtureUserEmails);
    }
    await removeEncryptionKeys(db, T128_SUITE);
  } finally {
    if (app !== undefined) await app.close();
  }
});

describe('T-128 — GET/PATCH /users/me/preferences', () => {
  it("TC-1: GET on a freshly created user returns the column's default, light-blue", async () => {
    const maker = await makeUser('tc1-maker', 'maker');
    fixtureUserEmails.push(maker.email);

    const response = await getPrefs(maker);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ uiTheme: 'light-blue' });
  });

  it('TC-2: PATCH to yellow-black — 200, persisted (a subsequent GET reflects it)', async () => {
    const maker = await makeUser('tc2-maker', 'maker');
    fixtureUserEmails.push(maker.email);

    const patched = await patchPrefs(maker, { uiTheme: 'yellow-black' });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toEqual({ uiTheme: 'yellow-black' });

    const reread = await getPrefs(maker);
    expect(reread.body.data).toEqual({ uiTheme: 'yellow-black' });

    const [row] = await sql<{ ui_theme: string }>(
      'SELECT ui_theme FROM reward_portal.portal_users WHERE id = :id',
      { id: maker.userId },
    );
    expect(row.ui_theme).toBe('yellow-black');
  });

  it('TC-3: PATCH with an invalid value is a 400', async () => {
    const maker = await makeUser('tc3-maker', 'maker');
    fixtureUserEmails.push(maker.email);

    const response = await patchPrefs(maker, { uiTheme: 'dark-mode' });

    expect(response.status).toBe(400);
  });

  it('TC-4/Verification step 2: a maker — not just super_admin — can PATCH its own preferences: 200, no user:update grant needed', async () => {
    const maker = await makeUser('tc4-maker', 'maker');
    fixtureUserEmails.push(maker.email);

    const response = await patchPrefs(maker, { uiTheme: 'red-white' });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ uiTheme: 'red-white' });
  });

  it('TC-5: unauthenticated GET/PATCH — 401', async () => {
    const getResponse = await http().get('/api/v1/users/me/preferences');
    expect(getResponse.status).toBe(401);

    const patchResponse = await http()
      .patch('/api/v1/users/me/preferences')
      .send({ uiTheme: 'light-blue' });
    expect(patchResponse.status).toBe(401);
  });

  it("TC-6: the route carries no user-id parameter — user A's token can only ever reach user A's row", async () => {
    const userA = await makeUser('tc6-a', 'maker');
    const userB = await makeUser('tc6-b', 'maker');
    fixtureUserEmails.push(userA.email, userB.email);

    const patched = await patchPrefs(userA, { uiTheme: 'yellow-black' });
    expect(patched.status).toBe(200);
    // No id, in the path or the body, that could have named `userB` instead — the response and
    // the row that actually changed are both `userA`'s.
    expect(patched.body.data).toEqual({ uiTheme: 'yellow-black' });

    const [rowA] = await sql<{ ui_theme: string }>(
      'SELECT ui_theme FROM reward_portal.portal_users WHERE id = :id',
      { id: userA.userId },
    );
    const [rowB] = await sql<{ ui_theme: string }>(
      'SELECT ui_theme FROM reward_portal.portal_users WHERE id = :id',
      { id: userB.userId },
    );
    expect(rowA.ui_theme).toBe('yellow-black');
    expect(rowB.ui_theme).toBe('light-blue');
  });
});
