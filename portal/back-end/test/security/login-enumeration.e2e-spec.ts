/**
 * T-051 TC-18 — **the four login failure causes must be indistinguishable**, in body and in time.
 *
 * 02-SECURITY.md §2 states this as a non-negotiable:
 *
 * > The response for *unknown user*, *wrong password*, *inactive*, and *locked* is byte-identical
 * > (`401`, `{ "code": "AUTH_INVALID_CREDENTIALS" }`) and takes comparable time. Distinguishing
 * > them is a user-enumeration vulnerability.
 *
 * The body half is easy and is asserted exactly — byte-for-byte, after the volatile `traceId` is
 * removed. The timing half is the interesting one, and this file is deliberate about how it
 * measures it, because a naive timing test is either flaky or meaningless.
 *
 * ### How the timing is measured, and what the threshold means
 *
 * The defence is that **Argon2id runs on every attempt**, including for an address that does not
 * exist (§2 step 2: "ALWAYS run Argon2 verify, even when the user is unknown (dummy hash)"). Argon2
 * dominates the response time by design — it costs tens of milliseconds — so if it were skipped for
 * an unknown user, that case would be *dramatically* faster, not marginally. The signal being
 * looked for is therefore large, and the test does not need microsecond precision to see it.
 *
 * Each case is sampled several times and compared on its **median**, which discards the scheduler
 * noise and GC pauses that make a mean useless on a laptop. The assertion is that the slowest and
 * fastest medians are within a factor of {@link MAX_MEDIAN_RATIO} — a ratio, not an absolute
 * millisecond budget, because the absolute numbers move with the machine while the ratio does not.
 * A missing dummy-hash verify would show up here as a ratio of roughly 10× or more.
 *
 * This is intentionally a coarse test of a coarse property. It cannot and does not claim the
 * endpoint is free of *all* timing side channels — a remote statistical attack over many thousands
 * of samples is outside what a functional test can rule out, and is recorded as a residual risk in
 * the report rather than pretended away.
 */
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { asExpressApplication, configureHttpSecurity } from '@/common/security/security.middleware';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import {
  MemoryThrottleStore,
  THROTTLE_STORE,
  type ThrottleCounter,
  type ThrottleStore,
} from '@/common/security/throttle.store';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import { bindTestServer } from './support/bound-app';

jest.setTimeout(600_000);

const SUITE = 't051enum';
const PASSWORD = 'correct horse battery staple 7!';
const WRONG_PASSWORD = 'definitely-not-the-password-42!';

const ACTIVE_EMAIL = 't051-enum-active@example.invalid';
const INACTIVE_EMAIL = 't051-enum-inactive@example.invalid';
const LOCKED_EMAIL = 't051-enum-locked@example.invalid';
const UNKNOWN_EMAIL = 't051-enum-nobody@example.invalid';

const EMAILS = [ACTIVE_EMAIL, INACTIVE_EMAIL, LOCKED_EMAIL, UNKNOWN_EMAIL];

/** Samples per case. Enough for a stable median without making the suite crawl. */
const SAMPLES = 7;

/**
 * The slowest median may be at most this many times the fastest.
 *
 * Generous on purpose: the property being defended is "Argon2 runs in every case", whose absence
 * produces an order-of-magnitude gap. A tight bound here would buy no additional security and
 * would make the suite fail on an unrelated laptop hiccup.
 */
const MAX_MEDIAN_RATIO = 3;

class ResettableThrottleStore implements ThrottleStore {
  readonly kind = 'memory' as const;
  private delegate = new MemoryThrottleStore();

  async consume(key: string, windowMs: number, now: number): Promise<ThrottleCounter> {
    return this.delegate.consume(key, windowMs, now);
  }

  reset(): void {
    this.delegate = new MemoryThrottleStore();
  }
}

interface Attempt {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly ms: number;
}

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let store: ResettableThrottleStore;

/** Set once in `beforeAll` by `bindTestServer` — see that helper for why this is not
 *  `request(app.getHttpServer())`. */
let baseUrl: string;

function http() {
  return request(baseUrl);
}

/** Strips the one field that legitimately differs between two otherwise identical responses. */
function withoutTraceId(body: unknown): unknown {
  const clone = JSON.parse(JSON.stringify(body)) as { error?: Record<string, unknown> };
  if (clone.error !== undefined) delete clone.error.traceId;
  return clone;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function attempt(email: string, password: string): Promise<Attempt> {
  // The counter store is cleared before every attempt: this suite drives far more failures against
  // one address than §8's 5-per-15-minutes allows, and a 429 is not one of the four cases under
  // test. The limiter itself is verified in `role-matrix.e2e-spec.ts` TC-17.
  store.reset();

  const started = process.hrtime.bigint();
  const response = await http().post('/api/v1/auth/login').send({ email, password });
  const ms = Number(process.hrtime.bigint() - started) / 1_000_000;

  return {
    status: response.status,
    body: response.body,
    headers: response.headers as Record<string, string>,
    ms,
  };
}

async function createUser(
  email: string,
  overrides: { status?: string; lockedMinutes?: number } = {},
): Promise<number> {
  const [country] = await db.query<{ id: number }>(
    `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
     VALUES ('ZE', 'T-051 enum', 'UTC', 'USD', '+000', 'active')
     ON CONFLICT (code) DO UPDATE SET status = 'active' RETURNING id`,
    { type: QueryTypes.SELECT },
  );
  const [tenant] = await db.query<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES ('T051_ENUM', 'T051_ENUM', :countryId, 'active')
     ON CONFLICT (code) DO UPDATE SET status = 'active', deleted_at = NULL RETURNING id`,
    { type: QueryTypes.SELECT, replacements: { countryId: country.id } },
  );

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-051 enum ${email}`,
    role: 'maker',
    countryId: country.id,
    tenantId: tenant.id,
    merchantId: null,
    status: overrides.status ?? 'active',
  });

  await db.query(
    `INSERT INTO reward_portal.portal_user_credentials
            (user_id, password_hash, password_algo, locked_until)
     VALUES (:userId, :hash, 'argon2id', :lockedUntil)`,
    {
      type: QueryTypes.INSERT,
      replacements: {
        userId,
        hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS),
        lockedUntil:
          overrides.lockedMinutes === undefined
            ? null
            : new Date(Date.now() + overrides.lockedMinutes * 60_000),
      },
    },
  );

  return userId;
}

beforeAll(async () => {
  store = new ResettableThrottleStore();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(THROTTLE_STORE)
    .useValue(store)
    .compile();

  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), SUITE);

  app = moduleRef.createNestApplication<NestExpressApplication>();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  configureHttpSecurity(asExpressApplication(app), {
    apiOrigin: process.env.API_ORIGIN ?? 'https://api.t051.example.test',
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS,
    trustProxy: undefined,
    enforceHttps: false,
  });
  baseUrl = await bindTestServer(app);

  db = app.get<Sequelize>(SEQUELIZE);
  emailCrypto = emailCryptoOf(app);

  await deletePortalUsersByEmail(db, emailCrypto, EMAILS);

  await createUser(ACTIVE_EMAIL);
  await createUser(INACTIVE_EMAIL, { status: 'inactive' });
  await createUser(LOCKED_EMAIL, { lockedMinutes: 15 });
  // UNKNOWN_EMAIL is deliberately never created.
});

afterAll(async () => {
  if (db !== undefined) {
    await deletePortalUsersByEmail(db, emailCrypto, EMAILS);
    await removeEncryptionKeys(db, SUITE);
  }
  await app?.close();
});

describe('TC-18: the four failure causes are byte-identical', () => {
  it('returns the same 401 and the same body for all four', async () => {
    const unknown = await attempt(UNKNOWN_EMAIL, WRONG_PASSWORD);
    const wrongPassword = await attempt(ACTIVE_EMAIL, WRONG_PASSWORD);
    const inactive = await attempt(INACTIVE_EMAIL, PASSWORD);
    const locked = await attempt(LOCKED_EMAIL, PASSWORD);

    const all = { unknown, wrongPassword, inactive, locked };

    for (const [cause, result] of Object.entries(all)) {
      expect({ cause, status: result.status }).toEqual({ cause, status: 401 });
    }

    // Byte-identical, not merely "the same code". A difference anywhere in the envelope — an
    // extra field, a different message, a `details` array present in one case — is an oracle.
    const reference = withoutTraceId(unknown.body);
    for (const [cause, result] of Object.entries(all)) {
      expect({ cause, body: withoutTraceId(result.body) }).toEqual({ cause, body: reference });
    }

    // And it is the documented envelope, so this cannot pass by every case being equally wrong.
    //
    // 02-SECURITY.md §2 writes the body as `{ "code": "AUTH_INVALID_CREDENTIALS" }`; the shipped
    // envelope also carries the human `message` from T-014's catalogue. That is a superset, not a
    // divergence, and it is safe precisely because the message is the *same generic sentence* in
    // all four cases — which the byte-identity check above has already established. Asserted here
    // rather than pinned to the literal §2 shape, because pinning it would fail on an addition
    // that changes nothing about the enumeration property.
    expect(reference).toEqual({
      error: {
        code: 'AUTH_INVALID_CREDENTIALS',
        message: expect.any(String) as unknown as string,
      },
    });

    const message = (reference as { error: { message: string } }).error.message;
    // The message must not name the cause — that would be an oracle in prose rather than in code.
    expect(message).not.toMatch(/lock|inactive|disabled|suspend|unknown|no such|not found|exist/i);
  });

  it('sets no cookie on any of the four', async () => {
    for (const [email, password] of [
      [UNKNOWN_EMAIL, WRONG_PASSWORD],
      [ACTIVE_EMAIL, WRONG_PASSWORD],
      [INACTIVE_EMAIL, PASSWORD],
      [LOCKED_EMAIL, PASSWORD],
    ]) {
      store.reset();
      const response = await http().post('/api/v1/auth/login').send({ email, password });
      expect({ email, cookies: response.headers['set-cookie'] }).toEqual({
        email,
        cookies: undefined,
      });
    }
  });

  it('never discloses lockout, which is recorded but not revealed', async () => {
    // §2: "Lockout is recorded but **never disclosed** in the response body."
    const locked = await attempt(LOCKED_EMAIL, PASSWORD);
    const serialised = JSON.stringify(locked.body);

    expect(serialised).not.toMatch(/lock|attempt|retry|until|disabled|inactive|suspend/i);
    expect(locked.status).toBe(401);

    // No `Retry-After`, and no header that would time the lock for a prober either.
    expect(locked.headers['retry-after']).toBeUndefined();

    // §2's other half — "lockout is **recorded**" — is asserted in the "§2 lockout" describe
    // below, and is currently broken (finding F-4 / T-082). It is deliberately not asserted here:
    // this test is about *disclosure*, and folding the two together would make a non-disclosure
    // regression indistinguishable from the recording defect.
  });

  it('proves the fixtures are real — the active account can actually log in', async () => {
    // Without this, all four cases could be 401 because every fixture was broken, and the
    // "indistinguishable" property would be trivially and uselessly true.
    store.reset();
    const response = await http()
      .post('/api/v1/auth/login')
      .send({ email: ACTIVE_EMAIL, password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.headers['set-cookie']).toBeDefined();
  });
});

/**
 * 02-SECURITY.md §2's *other* non-negotiable on this endpoint — found broken by T-051 finding
 * **F-4** and **fixed by T-082**, which is why the two tests below are now plain `it(...)`.
 *
 * > Lockout: 5 consecutive failures → `locked_until = now() + 15 min`, exponential on repeat.
 *
 * `LockoutService.registerFailure` was always correct in isolation: it writes the
 * `portal_login_attempts` row and advances `failed_attempts`. Both writes are handed the
 * transaction `AuthService.login()` opened — and `authenticateOrDeny` used to throw
 * `InvalidCredentialsHttpException` from **inside** that transaction's callback, so
 * `runInTransaction` rolled both of them back. The counter never advanced, the account never
 * locked, and the failure was never recorded. Measured on the live database before the fix: 7,031
 * rows in `portal_login_attempts`, every single one `success = true`, and no credential in the
 * entire database had ever reached `failed_attempts > 0`.
 *
 * T-082's fix returns a `denied` outcome from the transaction callback and raises the HTTP
 * exception after the commit, so the failure writes survive. These two tests were `it.failing`
 * while the defect stood — passing *because* their assertions failed — and flipping them back to
 * `it(...)` is part of that task's Definition of Done. They are the regression guard: revert
 * `auth.service.ts` and both go red.
 */
describe('§2 lockout (02-SECURITY.md §2) — regression guard for F-4 / T-082', () => {
  const LOCKOUT_PROBE_EMAIL = 't051-enum-lockout-probe@example.invalid';

  beforeAll(async () => {
    await deletePortalUsersByEmail(db, emailCrypto, [LOCKOUT_PROBE_EMAIL]);
    await createUser(LOCKOUT_PROBE_EMAIL);

    // Six consecutive failures: one more than LOCKOUT_THRESHOLD.
    for (let attemptNumber = 0; attemptNumber < 6; attemptNumber += 1) {
      await attempt(LOCKOUT_PROBE_EMAIL, WRONG_PASSWORD);
    }
  });

  afterAll(async () => {
    await deletePortalUsersByEmail(db, emailCrypto, [LOCKOUT_PROBE_EMAIL]);
  });

  it('locks the account after five consecutive failures', async () => {
    const [credential] = await db.query<{ failed_attempts: number; locked_until: string | null }>(
      `SELECT c.failed_attempts, c.locked_until
         FROM reward_portal.portal_user_credentials c
         JOIN reward_portal.portal_users u ON u.id = c.user_id
        WHERE u.email_bidx = :bidx`,
      {
        type: QueryTypes.SELECT,
        replacements: { bidx: emailCrypto.blindIndexFor(LOCKOUT_PROBE_EMAIL) },
      },
    );

    // Was failed_attempts = 0, locked_until = null before T-082.
    expect(credential.failed_attempts).toBeGreaterThanOrEqual(5);
    expect(credential.locked_until).not.toBeNull();

    // The lock is in the future — a timestamp that had already passed would satisfy the
    // not-null check above while leaving the account wide open.
    expect(new Date(credential.locked_until as string).getTime()).toBeGreaterThan(Date.now());

    // And the account is genuinely unreachable with the *correct* password while locked. This is
    // the assertion that matters: the two column checks above describe the mechanism, but this
    // one is the property 02-SECURITY.md §2 actually promises.
    store.reset();
    const withCorrectPassword = await http()
      .post('/api/v1/auth/login')
      .send({ email: LOCKOUT_PROBE_EMAIL, password: PASSWORD });
    // Was 200 before T-082. The account was never locked.
    expect(withCorrectPassword.status).toBe(401);
    // ...and still no session, in case a future change ever returns 401 with cookies attached.
    expect(withCorrectPassword.headers['set-cookie']).toBeUndefined();
  });

  it('records every failed attempt in portal_login_attempts', async () => {
    const [recorded] = await db.query<{ n: string; coded: string }>(
      `SELECT count(*) AS n, count(failure_code) AS coded
         FROM reward_portal.portal_login_attempts
        WHERE email = :email AND success = false`,
      { type: QueryTypes.SELECT, replacements: { email: LOCKOUT_PROBE_EMAIL } },
    );

    // Was 0 before T-082, against six failures driven in `beforeAll`.
    expect(Number(recorded.n)).toBeGreaterThanOrEqual(6);

    // `failure_code` had never been populated on any row in the database. It is the only thing
    // that makes the forensic trail readable — "six failures" and "six failures, all
    // wrong_password" are very different findings during an incident.
    expect(Number(recorded.coded)).toBe(Number(recorded.n));
  });

  it('records the successful attempts, which is why the gap is specifically about failures', async () => {
    // The control. Success rows *are* written — the transaction that carries them commits — so
    // the two expectations above are not failing because the table is unwritable or the fixture
    // is wrong. This one is a plain `it` and must stay green.
    store.reset();
    await http().post('/api/v1/auth/login').send({ email: ACTIVE_EMAIL, password: PASSWORD });

    const [recorded] = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM reward_portal.portal_login_attempts
        WHERE email = :email AND success = true`,
      { type: QueryTypes.SELECT, replacements: { email: ACTIVE_EMAIL } },
    );

    expect(Number(recorded.n)).toBeGreaterThan(0);
  });
});

describe('TC-18: the four failure causes take comparable time', () => {
  it('keeps every median within a small factor of every other', async () => {
    const cases: Record<string, [string, string]> = {
      unknown: [UNKNOWN_EMAIL, WRONG_PASSWORD],
      wrongPassword: [ACTIVE_EMAIL, WRONG_PASSWORD],
      inactive: [INACTIVE_EMAIL, PASSWORD],
      locked: [LOCKED_EMAIL, PASSWORD],
    };

    const medians: Record<string, number> = {};

    for (const [cause, [email, password]] of Object.entries(cases)) {
      const timings: number[] = [];
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        timings.push((await attempt(email, password)).ms);
      }
      medians[cause] = median(timings);
    }

    const values = Object.values(medians);
    const slowest = Math.max(...values);
    const fastest = Math.min(...values);

    /*
     * T-051: the measured medians are audit evidence and are quoted in the completion report; a
     * failure here is meaningless without the numbers in front of the reader.
     */
    // eslint-disable-next-line no-console -- see the comment directly above
    console.log(
      `\nTC-18 login timing medians over ${SAMPLES} samples (ms):\n` +
        Object.entries(medians)
          .map(([cause, ms]) => `  ${cause.padEnd(16)} ${ms.toFixed(1)}`)
          .join('\n') +
        `\n  ratio slowest/fastest = ${(slowest / fastest).toFixed(2)} (limit ${MAX_MEDIAN_RATIO})`,
    );

    expect(slowest / fastest).toBeLessThan(MAX_MEDIAN_RATIO);
  });

  it('spends real time on every attempt — the dummy Argon2 verify is running', async () => {
    // The positive statement of the same property. An unknown address that skipped Argon2 would
    // return in single-digit milliseconds; ARGON2_OPTIONS is deliberately expensive.
    const timings: number[] = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      timings.push((await attempt(UNKNOWN_EMAIL, WRONG_PASSWORD)).ms);
    }

    expect(median(timings)).toBeGreaterThan(10);
  });
});
