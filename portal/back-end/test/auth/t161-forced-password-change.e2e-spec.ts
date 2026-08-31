/**
 * T-161 — a forced password change must not re-trigger on every subsequent login.
 *
 * ### The defect this file pins down
 *
 * `CredentialService.authenticate()` derives `mustChangePassword` as
 * `portal_users.must_change_password || password_expires_at <= now()`. `AuthService.changePassword`
 * correctly clears the first, but before this task nothing ever cleared the second — so an account
 * provisioned through the temporary-password path (T-046, which always stamps
 * `password_expires_at`) kept a permanently-past timestamp on its credential row. Every later login
 * re-derived `mustChangePassword: true` from that stale column and `AuthService.login` wrote it
 * straight back into `portal_users`, undoing the change the user had just made. The user is
 * confined to `/auth/change-password` forever, no matter how many times they comply.
 *
 * ### Why this is an e2e test against real Postgres and not a unit test
 *
 * The bug is a *missing column write*. A unit test with a faked credential store asserts against a
 * hand-written in-memory row, so it can only prove the code does what the fake was told to model —
 * exactly the "change-detector" failure mode AGENT-PROTOCOL §3 warns about. The property that
 * actually matters ("after a successful change, is the column NULL in the database, and does the
 * *next real login* stop prompting?") is only observable through the real schema and the real login
 * path, so that is what this file drives: HTTP in, SQL assertions out.
 *
 * Fixtures are prefixed `t161-e2e` and removed in `afterAll`, following `auth.e2e-spec.ts`.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { CSRF_HEADER_NAME } from '@/common/security/security.constants';
import {
  MemoryThrottleStore,
  THROTTLE_STORE,
  type ThrottleCounter,
  type ThrottleStore,
} from '@/common/security/throttle.store';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from './support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';

jest.setTimeout(180_000);

const TEMP_PASSWORD = 'Issued-By-Admin-Once!7';
const CHOSEN_PASSWORD = 'Tr0ubador-Zephyr-Quill!42';
const SECOND_PASSWORD = 'Nimbus-Cartwright-Vellum!91';

/**
 * TC-4: the report said "check this for all roles". The defect is a property of the *credential
 * row*, not of the role — any account whose `password_expires_at` is set is affected, and the
 * temporary-password path stamps it for every role it provisions. Driving all five non-superadmin
 * roles through the same flow is what turns that reasoning into evidence.
 */
const ROLES = ['maker', 'checker', 'country_admin', 'tenant_admin', 'merchant'] as const;
type FixtureRole = (typeof ROLES)[number];

const emailFor = (role: FixtureRole): string =>
  `t161-e2e-${role.replace(/_/g, '-')}@example.invalid`;

/** See `auth.e2e-spec.ts` — this suite logs the same users in repeatedly. */
class ResettableThrottleStore implements ThrottleStore {
  readonly kind = 'memory' as const;

  private inner = new MemoryThrottleStore();

  async consume(key: string, windowMs: number, now: number): Promise<ThrottleCounter> {
    return this.inner.consume(key, windowMs, now);
  }

  reset(): void {
    this.inner = new MemoryThrottleStore();
  }
}

const throttle = new ResettableThrottleStore();

/** Namespaces this suite's encryption-key rows so parallel suites cannot delete each other's. */
const T056_SUITE = 't161auth';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let countryId: number;
let tenantId: number;
const userIds = new Map<FixtureRole, number>();

type HttpAgent = ReturnType<typeof request>;

function http(): HttpAgent {
  return request(app.getHttpServer());
}

function setCookies(response: request.Response): string[] {
  const header = response.headers['set-cookie'];
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [header];
}

function jarFrom(response: request.Response): string {
  return setCookies(response)
    .map((entry) => entry.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

function csrfOf(jar: string): string | undefined {
  const pair = jar.split('; ').find((entry) => entry.startsWith(`${CSRF_COOKIE_NAME}=`));
  return pair === undefined
    ? undefined
    : decodeURIComponent(pair.slice(CSRF_COOKIE_NAME.length + 1));
}

function mutating(method: 'post', path: string, jar: string) {
  const pending = http()[method](path).set('Cookie', jar);
  const csrf = csrfOf(jar);
  return csrf === undefined ? pending : pending.set(CSRF_HEADER_NAME, csrf);
}

async function scalar<T extends object>(
  sql: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return db.query<T>(sql, { type: QueryTypes.SELECT, replacements });
}

async function login(role: FixtureRole, password: string): Promise<request.Response> {
  return http()
    .post('/api/v1/auth/login')
    .send({ email: emailFor(role), password });
}

interface CredentialRow {
  password_expires_at: Date | null;
  password_updated_at: Date | null;
}

async function credentialOf(role: FixtureRole): Promise<CredentialRow> {
  const [row] = await scalar<CredentialRow>(
    `SELECT password_expires_at, password_updated_at
       FROM reward_portal.portal_user_credentials WHERE user_id = :userId`,
    { userId: userIds.get(role) },
  );
  if (row === undefined) throw new Error(`no credential row for ${role}`);
  return row;
}

async function mustChangeFlagOf(role: FixtureRole): Promise<boolean> {
  const [row] = await scalar<{ must_change_password: boolean }>(
    `SELECT must_change_password FROM reward_portal.portal_users WHERE id = :userId`,
    { userId: userIds.get(role) },
  );
  if (row === undefined) throw new Error(`no user row for ${role}`);
  return row.must_change_password;
}

/**
 * Puts an account back into the exact state the temporary-password flow leaves it in: a known
 * hash, `must_change_password = true`, and a `password_expires_at` in the past (the 72-hour window
 * having elapsed, which is the reliably-reproducing case from the product report).
 */
async function provisionAsTemporary(role: FixtureRole, expiresAt: Date): Promise<void> {
  const userId = userIds.get(role);
  await db.query(
    `UPDATE reward_portal.portal_users
        SET must_change_password = true, status = 'active', updated_at = now()
      WHERE id = :userId`,
    { type: QueryTypes.UPDATE, replacements: { userId } },
  );
  await db.query(
    `UPDATE reward_portal.portal_user_credentials
        SET password_hash = :hash, password_algo = 'argon2id', previous_hashes = NULL,
            failed_attempts = 0, locked_until = NULL, password_expires_at = :expiresAt,
            password_updated_at = now(), updated_at = now()
      WHERE user_id = :userId`,
    {
      type: QueryTypes.UPDATE,
      replacements: { userId, hash: await argon2.hash(TEMP_PASSWORD, ARGON2_OPTIONS), expiresAt },
    },
  );
  await db.query(`DELETE FROM reward_portal.portal_sessions WHERE user_id = :userId`, {
    type: QueryTypes.DELETE,
    replacements: { userId },
  });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(THROTTLE_STORE)
    .useValue(throttle)
    .compile();

  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), T056_SUITE);

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.listen(0);

  db = app.get<Sequelize>(SEQUELIZE);
  emailCrypto = emailCryptoOf(app);

  const [country] = await scalar<{ id: number }>(
    `SELECT id FROM reward_config.countries ORDER BY id LIMIT 1`,
  );
  if (country === undefined) throw new Error('no country row to build a fixture user on');
  countryId = country.id;

  const [tenant] = await scalar<{ id: number }>(
    `SELECT id FROM reward_config.tenants WHERE country_id = :countryId AND deleted_at IS NULL
      ORDER BY id LIMIT 1`,
    { countryId },
  );
  if (tenant === undefined) throw new Error('no tenant row to build a fixture user on');
  tenantId = tenant.id;

  const [merchant] = await scalar<{ id: number }>(
    `SELECT id FROM reward_config.merchants WHERE tenant_id = :tenantId AND deleted_at IS NULL
      ORDER BY id LIMIT 1`,
    { tenantId },
  );

  await deletePortalUsersByEmail(
    db,
    emailCrypto,
    ROLES.map((role) => emailFor(role)),
  );

  for (const role of ROLES) {
    const userId = await insertPortalUser(db, emailCrypto, {
      email: emailFor(role),
      displayName: `T-161 ${role}`,
      role,
      countryId,
      tenantId: role === 'country_admin' ? null : tenantId,
      merchantId: role === 'merchant' ? (merchant?.id ?? null) : null,
      status: 'active',
      mustChangePassword: true,
    });
    userIds.set(role, userId);

    await db.query(
      `INSERT INTO reward_portal.portal_user_credentials
              (user_id, password_hash, password_algo, password_expires_at,
               password_updated_at, created_at, updated_at)
       VALUES (:userId, :hash, 'argon2id', now() - interval '1 hour', now(), now(), now())`,
      {
        type: QueryTypes.INSERT,
        replacements: { userId, hash: await argon2.hash(TEMP_PASSWORD, ARGON2_OPTIONS) },
      },
    );
  }
});

afterAll(async () => {
  if (db !== undefined) {
    await deletePortalUsersByEmail(
      db,
      emailCrypto,
      ROLES.map((role) => emailFor(role)),
    );
    await removeEncryptionKeys(db, T056_SUITE);
  }
  if (app !== undefined) await app.close();
});

beforeEach(() => {
  throttle.reset();
});

describe('TC-1 / TC-2 — the reported flow: log in, change password, log in again', () => {
  it('stops prompting for a change once the password has actually been changed', async () => {
    const role: FixtureRole = 'maker';
    await provisionAsTemporary(role, new Date(Date.now() - 60 * 60 * 1000));

    // First login: the forced change is correct here and must stay (task "Out of scope").
    const first = await login(role, TEMP_PASSWORD);
    expect(first.status).toBe(200);
    expect(first.body.data.mustChangePassword).toBe(true);

    const jar = jarFrom(first);
    await expect(
      mutating('post', '/api/v1/auth/change-password', jar).send({
        currentPassword: TEMP_PASSWORD,
        newPassword: CHOSEN_PASSWORD,
      }),
    ).resolves.toMatchObject({ status: 204 });

    // TC-3's assertion, at the only layer that can prove it.
    const credential = await credentialOf(role);
    expect(credential.password_expires_at).toBeNull();
    expect(await mustChangeFlagOf(role)).toBe(false);

    // TC-2: the second login is the one that reproduced the bug.
    throttle.reset();
    const second = await login(role, CHOSEN_PASSWORD);
    expect(second.status).toBe(200);
    expect(second.body.data.mustChangePassword).toBe(false);

    // ...and the login must not have written the flag back to the user row.
    expect(await mustChangeFlagOf(role)).toBe(false);
  });

  it('still forces the change on the first login and confines that session until it happens', async () => {
    // The control this fix must not weaken: a brand-new temporary password is still single-use.
    const role: FixtureRole = 'checker';
    await provisionAsTemporary(role, new Date(Date.now() - 60 * 60 * 1000));

    const first = await login(role, TEMP_PASSWORD);
    expect(first.status).toBe(200);
    expect(first.body.data.mustChangePassword).toBe(true);

    // `PasswordChangeRequiredGuard` confines the session to change-password/logout.
    const jar = jarFrom(first);
    const blocked = await http().get('/api/v1/auth/sessions').set('Cookie', jar);
    expect(blocked.status).toBe(403);
  });
});

describe('TC-4 — every role provisioned through the temporary-password path', () => {
  it.each(ROLES)('clears the stale expiry for %s', async (role) => {
    await provisionAsTemporary(role, new Date(Date.now() - 60 * 60 * 1000));

    const first = await login(role, TEMP_PASSWORD);
    expect(first.status).toBe(200);
    expect(first.body.data.mustChangePassword).toBe(true);

    const jar = jarFrom(first);
    await expect(
      mutating('post', '/api/v1/auth/change-password', jar).send({
        currentPassword: TEMP_PASSWORD,
        newPassword: SECOND_PASSWORD,
      }),
    ).resolves.toMatchObject({ status: 204 });

    expect((await credentialOf(role)).password_expires_at).toBeNull();

    throttle.reset();
    const second = await login(role, SECOND_PASSWORD);
    expect(second.status).toBe(200);
    expect(second.body.data.mustChangePassword).toBe(false);
  });
});

describe('a still-valid expiry is not cleared by anything except an actual change', () => {
  it('leaves a future password_expires_at in place for an account that has not changed yet', async () => {
    // The row the backfill migration must *not* touch, proven at the behavioural layer too: an
    // account still inside its 72-hour window has not changed its password, so the forced-change
    // control must remain armed.
    const role: FixtureRole = 'tenant_admin';
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await provisionAsTemporary(role, future);

    const response = await login(role, TEMP_PASSWORD);
    expect(response.status).toBe(200);
    // `must_change_password` is true in its own right here, which is what forces the change.
    expect(response.body.data.mustChangePassword).toBe(true);

    const credential = await credentialOf(role);
    expect(credential.password_expires_at).not.toBeNull();
  });
});
