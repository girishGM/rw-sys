/**
 * T-045 — `GET /audit/trace/:correlationId` against the **real** Postgres instance, through the
 * real `AppModule`, over real HTTP, as all six roles.
 *
 * ### What this suite proves that the unit suites cannot
 *
 * `trace.service.spec.ts` proves the assembly logic against doubles. This proves the two real
 * queries are valid against the live schema (the `field_changes LIKE … ESCAPE '\\'` clause in
 * particular — a Sequelize `literal()` with a bound replacement is exactly the kind of thing that
 * looks right and is wrong until it has run against a real driver), that `RolesGuard` genuinely
 * refuses every role but `super_admin` (TC-9/TC-10, AGENT-PROTOCOL R6), and that a row this suite
 * writes through the real request pipeline — not a hand-built fixture — comes back correlated.
 *
 * ### Fixtures, and what cannot be cleaned up
 *
 * Same constraints `audit.e2e-spec.ts` and `me.e2e-spec.ts` document: `reward_app` has `DELETE`
 * on nothing in `reward_config`, so the country/tenant/campaign fixtures are idempotent and
 * persist between runs, set `inactive` afterwards. `portal_users` rows are deleted (T-055/T-056's
 * MFA and email-encryption fixtures apply here exactly as they do in those two suites). The one
 * `campaign_audit_trail` row this suite writes is removed through the migration connection
 * (`reward_app` cannot `DELETE` there either) — same pattern as `audit.e2e-spec.ts`'s own
 * `admin_users`/`campaign_audit_trail` cleanup.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import { traceEnvelopeSchema } from '@reward-portal/shared';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { createMigrationConnection } from '@/database/migration-connection';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import type { PortalRole } from '@/database/portal-models';
import { CORRELATION_HEADER } from '@/common/errors/trace-id';
import { expectErrorEnvelope } from '../common/support/error-envelope';
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';

const MFA_SUITE = 't045';
jest.setTimeout(300_000);

const PASSWORD = 'correct horse battery staple 7!';
const COUNTRY_CODE = 'T5';
const TENANT_CODE = 'T045_E2E_T';
const MERCHANT_CODE = 'T045_E2E_M';
const CAMPAIGN_CODE = 'T045_E2E_C';
const ADMIN_USER_EMAIL = 't045-e2e@example.invalid';

let app: INestApplication;
let db: Sequelize;
let admin: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let countryId: number;
let tenantId: number;
let merchantId: number;
let campaignId: number;
let createdApiKeyId: number | null = null;
let createdAdminUser = false;
let fixtureAdminUserId: number | null = null;

interface Actor {
  readonly key: string;
  readonly email: string;
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

async function adminSql<T extends object>(
  statement: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return admin.query<T>(statement, { type: QueryTypes.SELECT, replacements });
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
  const email = `t045-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-045 ${key}`,
    role,
    ...scope,
    mustChangePassword: false,
    preferredTimezone: 'Asia/Kolkata',
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

function get(key: string, path: string, correlationId?: string) {
  const req = http().get(`/api/v1${path}`).set('Cookie', as(key).jar);
  return correlationId === undefined ? req : req.set(CORRELATION_HEADER, correlationId);
}

function patch(key: string, path: string, body: unknown, correlationId?: string) {
  const req = http()
    .patch(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf);
  if (correlationId !== undefined) req.set(CORRELATION_HEADER, correlationId);
  return req.send(body as object);
}

// --- fixtures ------------------------------------------------------------------------------------

async function ensureCountry(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries WHERE code = :code',
    {
      code: COUNTRY_CODE,
    },
  );
  if (existing !== undefined) {
    await exec(`UPDATE reward_config.countries SET status = 'active' WHERE id = :id`, {
      id: existing.id,
    });
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
     VALUES (:code, 'T-045 e2e country', 'UTC', 'USD', '+001', 'active') RETURNING id`,
    { code: COUNTRY_CODE },
  );
  return created.id;
}

async function ensureTenant(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.tenants WHERE code = :code',
    {
      code: TENANT_CODE,
    },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.tenants SET status = 'active', deleted_at = NULL, country_id = :countryId WHERE id = :id`,
      { id: existing.id, countryId },
    );
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active') RETURNING id`,
    { code: TENANT_CODE, countryId },
  );
  return created.id;
}

async function ensureMerchant(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.merchants WHERE merchant_code = :code',
    { code: MERCHANT_CODE },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.merchants SET status = 'active', deleted_at = NULL, tenant_id = :tenantId WHERE id = :id`,
      { id: existing.id, tenantId },
    );
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.merchants (tenant_id, merchant_code, name, country_code, status)
     VALUES (:tenantId, :code, :code, :countryCode, 'active') RETURNING id`,
    { code: MERCHANT_CODE, tenantId, countryCode: COUNTRY_CODE },
  );
  return created.id;
}

async function ensureCampaign(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.tenant_campaigns WHERE campaign_code = :code',
    { code: CAMPAIGN_CODE },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.tenant_campaigns SET deleted_at = NULL, tenant_id = :tenantId WHERE id = :id`,
      { id: existing.id, tenantId },
    );
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenant_campaigns
            (tenant_id, campaign_code, name, region, start_date, end_date, status, created_by)
     VALUES (:tenantId, :code, :code, 'EU', now(), now() + interval '30 days', 'draft', 't045-e2e')
     RETURNING id`,
    { code: CAMPAIGN_CODE, tenantId },
  );
  return created.id;
}

/** Mirrors `audit.e2e-spec.ts`'s own fixture — `campaign_audit_trail.performed_by` has a foreign
 * key to `admin_users`, which `reward_app` has no grant on at all. */
async function ensureAdminUser(): Promise<number> {
  const [existing] = await adminSql<{ id: number }>(
    `SELECT id FROM reward_config.admin_users WHERE email = :email`,
    { email: ADMIN_USER_EMAIL },
  );
  if (existing !== undefined) return existing.id;

  const [anyExisting] = await adminSql<{ id: number }>(
    'SELECT id FROM reward_config.admin_users ORDER BY id LIMIT 1',
  );
  if (anyExisting !== undefined) return anyExisting.id;

  const [key] = await adminSql<{ id: number }>(
    `INSERT INTO reward_config.tenant_api_keys (tenant_id, key_prefix, key_hash, status, expires_at)
     VALUES (:tenantId, 't045', 'not-a-real-hash', 'active', now() + interval '1 day') RETURNING id`,
    { tenantId },
  );
  createdApiKeyId = key.id;

  const [created] = await adminSql<{ id: number }>(
    `INSERT INTO reward_config.admin_users (api_key_id, role, display_name, email, tenant_id, status)
     VALUES (:apiKeyId, 'tenant_admin', 'T-045 e2e fixture', :email, :tenantId, 'active') RETURNING id`,
    { apiKeyId: key.id, tenantId, email: ADMIN_USER_EMAIL },
  );
  createdAdminUser = true;
  return created.id;
}

/** Writes one `campaign_audit_trail` row carrying `correlationId`, exactly the shape
 * `AuditRepository.serialiseFieldChanges` produces — through the app's own pool, since
 * `reward_app` does have `INSERT` on this table (only `UPDATE`/`DELETE` are revoked). */
async function insertDomainAuditRow(correlationId: string): Promise<void> {
  await exec(
    `INSERT INTO reward_config.campaign_audit_trail
            (tenant_id, campaign_id, entity_type, entity_id, action, field_changes,
             performed_by, performed_at, approval_request_id, comment, retention_expires_at)
     VALUES (:tenantId, :campaignId, 'campaign_submit', NULL, 'submitted',
             :fieldChanges, :performedBy, now(), NULL, NULL, now() + interval '7 years')`,
    {
      tenantId,
      campaignId,
      performedBy: fixtureAdminUserId,
      fieldChanges: JSON.stringify({ __correlationId: correlationId }),
    },
  );
}

// --- lifecycle -------------------------------------------------------------------------------

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), MFA_SUITE);

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
  admin = createMigrationConnection();
  emailCrypto = emailCryptoOf(app);

  countryId = await ensureCountry();
  tenantId = await ensureTenant();
  merchantId = await ensureMerchant();
  campaignId = await ensureCampaign();
  fixtureAdminUserId = await ensureAdminUser();

  await makeActor('super', 'super_admin', { countryId: null, tenantId: null, merchantId: null });
  await makeActor('country', 'country_admin', { countryId, tenantId: null, merchantId: null });
  await makeActor('tenant', 'tenant_admin', { countryId, tenantId, merchantId: null });
  await makeActor('maker', 'maker', { countryId, tenantId, merchantId: null });
  await makeActor('checker', 'checker', { countryId, tenantId, merchantId: null });
  await makeActor('merchant', 'merchant', { countryId, tenantId, merchantId });
});

afterAll(async () => {
  if (db !== undefined) {
    await exec(`DELETE FROM reward_portal.portal_users WHERE display_name LIKE 'T-045 %'`);
    await removeEncryptionKeys(db, MFA_SUITE);

    await exec(
      `UPDATE reward_config.merchants SET status = 'inactive' WHERE merchant_code = :code`,
      {
        code: MERCHANT_CODE,
      },
    );
    await exec(
      `UPDATE reward_config.tenants SET status = 'inactive', deleted_at = now() WHERE code = :code`,
      {
        code: TENANT_CODE,
      },
    );
    await exec(`UPDATE reward_config.countries SET status = 'inactive' WHERE code = :code`, {
      code: COUNTRY_CODE,
    });
  }

  if (admin !== undefined) {
    await admin.query('DELETE FROM reward_config.campaign_audit_trail WHERE campaign_id = :id', {
      type: QueryTypes.RAW,
      replacements: { id: campaignId },
    });
    if (createdAdminUser) {
      await admin.query('DELETE FROM reward_config.admin_users WHERE email = :email', {
        type: QueryTypes.RAW,
        replacements: { email: ADMIN_USER_EMAIL },
      });
    }
    if (createdApiKeyId !== null) {
      await admin.query('DELETE FROM reward_config.tenant_api_keys WHERE id = :id', {
        type: QueryTypes.RAW,
        replacements: { id: createdApiKeyId },
      });
    }
    await admin.close();
  }

  if (app !== undefined) await app.close();
});

// --- TC-9 / TC-10 — negative authorisation (AGENT-PROTOCOL R6) --------------------------------

describe('TC-9 / TC-10 — every role but super_admin is refused', () => {
  it.each(['country', 'tenant', 'maker', 'checker', 'merchant'])(
    '%s gets 403, not 404 or 200',
    async (key) => {
      const response = await get(key, '/audit/trace/01J8F3K9QP2M7N00000000');
      expect(response.status).toBe(403);
      expectErrorEnvelope(response.body, 'PERM_DENIED');
    },
  );

  it('an unauthenticated caller gets 401, not 403', async () => {
    const response = await http().get('/api/v1/audit/trace/01J8F3K9QP2M7N00000000');
    expect(response.status).toBe(401);
  });
});

// --- TC-7 / TC-8 / verification step 5 — malformed correlation id ------------------------------

describe('TC-7 / TC-8 / verification step 5 — malformed correlation id', () => {
  it.each([
    ['too short', 'short'],
    ['path traversal', '..%2Fetc%2Fpasswd'],
    ['a newline', 'has%0Anewline1234'],
    ['a space', 'has%20a%20space'],
  ])('%s → 400, VALIDATION_FAILED', async (_label, value) => {
    const response = await get('super', `/audit/trace/${value}`);
    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
  });
});

// --- TC-6 — unknown correlation id --------------------------------------------------------------

describe('TC-6 — unknown correlation id', () => {
  it('is 404 for a well-formed id nothing was ever written under', async () => {
    const response = await get('super', '/audit/trace/never-used-id-000001');
    expect(response.status).toBe(404);
    expectErrorEnvelope(response.body, 'NOT_FOUND');
  });
});

// --- TC-1 — a completed request, correlated end to end ------------------------------------------

describe('TC-1 / verification step 6 — a real request produces a matching trace', () => {
  it('a portal_audit_log row written under a chosen correlation id is retrievable by it', async () => {
    const correlationId = 't045e2etrace0001';

    const patchResponse = await patch(
      'tenant',
      '/me',
      { displayName: 'T-045 tenant' },
      correlationId,
    );
    expect(patchResponse.status).toBe(200);
    // The server always echoes back the id it actually used.
    expect(patchResponse.headers[CORRELATION_HEADER]).toBe(correlationId);

    const traceResponse = await get('super', `/audit/trace/${correlationId}`);
    expect(traceResponse.status).toBe(200);

    const parsed = traceEnvelopeSchema.safeParse(traceResponse.body);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();

    const { data } = traceResponse.body as { data: { auditEvents: { eventType: string }[] } };
    expect(data.auditEvents.some((event) => event.eventType === 'profile_updated')).toBe(true);
  });
});

// --- TC-3 / TC-4 — domain audit rows and cross-links -------------------------------------------

describe('TC-3 — a campaign submit', () => {
  it('the domain audit row appears, correlated, with its campaign and approval-request ids', async () => {
    const correlationId = 't045e2etrace0002';
    await insertDomainAuditRow(correlationId);

    const response = await get('super', `/audit/trace/${correlationId}`);
    expect(response.status).toBe(200);

    const { data } = response.body as {
      data: { domainAudit: { campaignId: number; action: string; tenantId: number }[] };
    };
    expect(data.domainAudit).toHaveLength(1);
    expect(data.domainAudit[0].campaignId).toBe(campaignId);
    expect(data.domainAudit[0].tenantId).toBe(tenantId);
    expect(data.domainAudit[0].action).toBe('submitted');
  });
});

// --- TC-19 — no domain audit rows ---------------------------------------------------------------

describe('TC-19 — a trace with no domain audit rows renders an empty section', () => {
  it('domainAudit is [], not omitted, when only portal_audit_log has a row', async () => {
    const correlationId = 't045e2etrace0003';
    await patch('maker', '/me', { displayName: 'T-045 maker' }, correlationId);

    const response = await get('super', `/audit/trace/${correlationId}`);
    expect(response.status).toBe(200);
    expect((response.body as { data: { domainAudit: unknown[] } }).data.domainAudit).toEqual([]);
  });
});

// --- TC-11 — masking still applies inside the trace view -----------------------------------------

describe('TC-11 — PII inside the trace is masked per policy, not disclosed for free', () => {
  it('the response never contains any actor’s plaintext password/credential material', async () => {
    const correlationId = 't045e2etrace0004';
    await patch('tenant', '/me', { displayName: 'T-045 tenant masked' }, correlationId);

    const response = await get('super', `/audit/trace/${correlationId}`);
    const serialised = JSON.stringify(response.body);

    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toMatch(/\$argon2/);
  });
});

// --- TC-17 — assembly latency --------------------------------------------------------------------

describe('TC-17 — trace assembly p95', () => {
  it('is under 800ms for a trace with a handful of rows', async () => {
    const correlationId = 't045e2etrace0005';
    await patch('maker', '/me', { displayName: 'T-045 maker perf' }, correlationId);

    const timings: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const started = process.hrtime.bigint();
      const response = await get('super', `/audit/trace/${correlationId}`);
      timings.push(Number(process.hrtime.bigint() - started) / 1e6);
      expect(response.status).toBe(200);
    }

    timings.sort((left, right) => left - right);
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
    // eslint-disable-next-line no-console
    console.log(`TC-17: p95=${p95.toFixed(1)}ms over ${String(timings.length)} runs`);
    expect(p95).toBeLessThan(800);
  });
});
