/**
 * T-119 — `POST`/`PATCH /rewards/:rewardId/versions` carrying the reward `Kind` and its per-kind
 * `valueConfig`, over real HTTP, through the real `AppModule`, against the real database.
 * Harness copied from `versions.e2e-spec.ts` (T-041) — real login through MFA, real cookies, real
 * guards — narrowed to the one `super_admin` actor these cases need.
 *
 * These are TC-1…TC-5 asserted where the task file actually states them: as **status codes**.
 * The service unit tests in `reward-version-kind.spec.ts` prove the same decisions in isolation,
 * but only this suite exercises the layer that decides whether a 201 is really a 201 — the global
 * `ValidationPipe` (`whitelist: true, forbidNonWhitelisted: true`, which silently drops or
 * rejects any field a DTO does not declare) and the response body the SPA's own
 * `rewardVersionSchema` then has to validate. A DTO field that existed only in the service's
 * imagination would pass every unit test in this repo and 400 in a browser.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import { rewardVersionSchema } from '@reward-portal/shared';
import { AppModule } from '@/app.module';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { createMigrationConnection } from '@/database/migration-connection';
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

const SUITE = 't119v';
const PASSWORD = 'correct horse battery staple 7!';
const SYSTEM_CODE = 'ZT119_E2E_REWARD';

const MULTI_CURRENCY_CONFIG = {
  multiCurrency: true,
  currencyValues: [
    { currency: 'MYR', value: 10 },
    { currency: 'SGD', value: 3.5 },
  ],
};

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let superUserId: number;
let jar: string;
let csrf: string;
let rewardId: number;

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

function post(path: string, body: unknown = {}) {
  return http()
    .post(`/api/v1${path}`)
    .set('Cookie', jar)
    .set('X-CSRF-Token', csrf)
    .send(body as object);
}

function patch(path: string, body: unknown) {
  return http()
    .patch(`/api/v1${path}`)
    .set('Cookie', jar)
    .set('X-CSRF-Token', csrf)
    .send(body as object);
}

function get(path: string) {
  return http().get(`/api/v1${path}`).set('Cookie', jar);
}

/** A fresh `draft` version of the fixture reward: whatever draft the previous case left behind is
 * published first, since `uq_rewv_one_draft` allows exactly one per reward. */
async function freshDraft(body: unknown = {}): Promise<request.Response> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.reward_versions
      WHERE reward_id = :rewardId AND status = 'draft'`,
    { rewardId },
  );
  if (existing !== undefined) {
    const published = await post(
      `/rewards/${String(rewardId)}/versions/${String(existing.id)}/publish`,
    );
    expect(published.status).toBe(201);
  }
  return post(`/rewards/${String(rewardId)}/versions`, body);
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), SUITE);

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

  const email = `${SUITE}-super@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);
  superUserId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: 'T-119 super',
    role: 'super_admin',
    countryId: null,
    tenantId: null,
    merchantId: null,
    mustChangePassword: false,
  });
  await exec(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { userId: superUserId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
  );
  const login = await loginCompletingMfa(app, { email, password: PASSWORD }, db);
  if (login.status !== 200) throw new Error(`login failed: ${String(login.status)}`);
  jar = jarFrom(login);
  csrf = cookieValue(login, CSRF_COOKIE_NAME);

  await exec(`DELETE FROM reward_config.reward_systems WHERE system_code = :code`, {
    code: SYSTEM_CODE,
  });
  const [reward] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_systems
       (tenant_id, system_code, name, reward_type, connector_type)
     VALUES (NULL, :code, 'T-119 e2e reward', 'cashback', 'internal_api')
     RETURNING id`,
    { code: SYSTEM_CODE },
  );
  rewardId = reward.id;
});

afterAll(async () => {
  if (db !== undefined) {
    // Published versions are undeletable by design (T-005's trigger) — the same superuser escape
    // hatch `versions.e2e-spec.ts` documents in full is used for teardown only.
    const migration = createMigrationConnection();
    await migration.authenticate();
    await migration.query(
      `ALTER TABLE reward_config.reward_versions DISABLE TRIGGER trg_reward_versions_undeletable`,
      { type: QueryTypes.RAW },
    );
    await exec(`DELETE FROM reward_config.reward_versions WHERE reward_id = :rewardId`, {
      rewardId,
    });
    await migration.query(
      `ALTER TABLE reward_config.reward_versions ENABLE TRIGGER trg_reward_versions_undeletable`,
      { type: QueryTypes.RAW },
    );
    await migration.close();
    await exec(`DELETE FROM reward_config.reward_systems WHERE id = :rewardId`, { rewardId });
    await exec('DELETE FROM reward_portal.portal_users WHERE id = :id', { id: superUserId });
    await removeEncryptionKeys(db, SUITE);
  }
  if (app !== undefined) await app.close();
});

describe('T-119 — POST /rewards/:rewardId/versions with a Kind', () => {
  // First case in the file deliberately: this reward has no version at all yet, so it is the one
  // moment a bootstrapped v1 can be observed. Every later draft clones the latest published
  // version, Kind included (proved in `reward-version-kind.spec.ts`).
  it('TC-7: the very first draft of a reward with no Kind comes back with both halves null', async () => {
    const response = await freshDraft({});
    expect(response.status).toBe(201);
    expect(response.body.data.versionNo).toBe(1);
    expect(response.body.data.rewardKind).toBeNull();
    expect(response.body.data.valueConfig).toBeNull();
  });

  it('TC-1: FIXED_AMOUNT with multiCurrency: true and two currencies → 201', async () => {
    const response = await freshDraft({
      rewardKind: 'FIXED_AMOUNT',
      valueConfig: MULTI_CURRENCY_CONFIG,
    });

    expect(response.status).toBe(201);
    expect(response.body.data.rewardKind).toBe('FIXED_AMOUNT');
    expect(response.body.data.valueConfig).toEqual(MULTI_CURRENCY_CONFIG);
  });

  it('TC-2: multiCurrency: true with an empty currencyValues → 400', async () => {
    const response = await freshDraft({
      rewardKind: 'FIXED_AMOUNT',
      valueConfig: { multiCurrency: true, currencyValues: [] },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([
      { field: 'valueConfig', code: 'INVALID_REWARD_VALUE_CONFIG' },
    ]);
  });

  it('TC-3: PERCENTAGE with percentage: 150 → 400', async () => {
    const response = await freshDraft({
      rewardKind: 'PERCENTAGE',
      valueConfig: { percentage: 150 },
    });
    expect(response.status).toBe(400);
  });

  it('TC-4: PROMO_CODE with an empty bindLevels → 400', async () => {
    const response = await freshDraft({
      rewardKind: 'PROMO_CODE',
      valueConfig: { apiProvider: 'PROMO_CODE_CONFIG_SERVICE', bindLevels: [] },
    });
    expect(response.status).toBe(400);
  });

  it('TC-5 / verification step 3: PROMO_CODE against the seeded, `planned` provider → 201', async () => {
    const [provider] = await sql<{ status: string }>(
      `SELECT status FROM reward_config.field_api_lookup_providers
        WHERE provider_code = 'PROMO_CODE_CONFIG_SERVICE'`,
    );
    // The point of the case: the provider really is `planned`, and authoring against it is still
    // allowed (13-REWARD-MASTER-VALUE-SOURCES.md §3).
    expect(provider?.status).toBe('planned');

    const response = await freshDraft({
      rewardKind: 'PROMO_CODE',
      valueConfig: {
        apiProvider: 'PROMO_CODE_CONFIG_SERVICE',
        bindLevels: ['component', 'tracker', 'campaign'],
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.valueConfig.bindLevels).toEqual(['component', 'tracker', 'campaign']);
  });

  it('rejects a Kind outside the vocabulary before it ever reaches the CHECK constraint', async () => {
    const response = await freshDraft({ rewardKind: 'GIFT_CARD' });
    expect(response.status).toBe(400);
  });
});

describe('T-119 — PATCH /rewards/:rewardId/versions/:vid', () => {
  it('sets the Kind pair on an existing draft, and GET reflects it', async () => {
    const created = await freshDraft({});
    const versionId = created.body.data.id as number;

    const updated = await patch(`/rewards/${String(rewardId)}/versions/${String(versionId)}`, {
      rewardKind: 'POINTS',
      valueConfig: { points: 500 },
    });
    expect(updated.status).toBe(200);

    const fetched = await get(`/rewards/${String(rewardId)}/versions/${String(versionId)}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.rewardKind).toBe('POINTS');
    expect(fetched.body.data.valueConfig).toEqual({ points: 500 });
  });

  it('refuses a config that contradicts the Kind already stored on the draft → 400', async () => {
    const created = await freshDraft({ rewardKind: 'PERCENTAGE', valueConfig: { percentage: 10 } });
    const versionId = created.body.data.id as number;

    const updated = await patch(`/rewards/${String(rewardId)}/versions/${String(versionId)}`, {
      valueConfig: { points: 500 },
    });

    expect(updated.status).toBe(400);
  });

  it('clears the pair back to null on a draft', async () => {
    const created = await freshDraft({ rewardKind: 'POINTS', valueConfig: { points: 1 } });
    const versionId = created.body.data.id as number;

    const updated = await patch(`/rewards/${String(rewardId)}/versions/${String(versionId)}`, {
      rewardKind: null,
      valueConfig: null,
    });

    expect(updated.status).toBe(200);
    expect(updated.body.data.rewardKind).toBeNull();
    expect(updated.body.data.valueConfig).toBeNull();
  });

  it('TC-6: a published version’s Kind cannot be changed through the API either', async () => {
    const created = await freshDraft({ rewardKind: 'POINTS', valueConfig: { points: 42 } });
    const versionId = created.body.data.id as number;
    const published = await post(
      `/rewards/${String(rewardId)}/versions/${String(versionId)}/publish`,
    );
    expect(published.status).toBe(201);

    const updated = await patch(`/rewards/${String(rewardId)}/versions/${String(versionId)}`, {
      valueConfig: { points: 999999 },
    });
    expect(updated.status).toBe(409);

    // …and the row itself is unchanged, which is the property that actually matters.
    const [row] = await sql<{ value_config: string }>(
      `SELECT value_config FROM reward_config.reward_versions WHERE id = :id`,
      { id: versionId },
    );
    expect(JSON.parse(row.value_config)).toEqual({ points: 42 });
  });
});

describe('T-119 — the response the SPA validates', () => {
  it('every listed reward version satisfies the shared rewardVersionSchema', async () => {
    await freshDraft({ rewardKind: 'PHYSICAL', valueConfig: { sku: 'MUG', description: 'Mug' } });

    const response = await get(`/rewards/${String(rewardId)}/versions`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data.length).toBeGreaterThan(0);
    for (const row of response.body.data) {
      const parsed = rewardVersionSchema.safeParse(row);
      if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
      expect(parsed.success).toBe(true);
    }
  });
});
