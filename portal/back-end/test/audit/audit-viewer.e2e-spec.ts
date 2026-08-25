/**
 * T-040 — `/audit/campaigns` and `/audit/portal` against the **real** Postgres instance, through
 * the real `AppModule`, over real HTTP, as several roles.
 *
 * Rows are written through the **real** `AuditService` (T-014) — `app.get(AuditService)` — rather
 * than a raw `INSERT`, for the same reason `TC-21`'s secrets-scan test needs: this suite must
 * prove that whatever redaction T-014 already applies at write time survives this task's read and
 * CSV-export paths unchanged, not merely that a hand-picked fixture value looks clean.
 *
 * ### Fixtures, and what cannot be cleaned up
 *
 * Same constraint `audit.e2e-spec.ts`/`trace.e2e-spec.ts` document: `reward_app` has no `DELETE`
 * on `reward_config.countries`/`tenants`/`tenant_campaigns`, so those fixtures are idempotent and
 * persist between runs. `campaign_audit_trail` rows this suite writes, and the `admin_users`/
 * `tenant_api_keys` fixture, are removed through the privileged migration connection.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { createMigrationConnection } from '@/database/migration-connection';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { AuditService } from '@/common/audit/audit.service';
import type { PortalRole } from '@/database/portal-models';
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';

const T056_SUITE = 't040a';
jest.setTimeout(300_000);

const PASSWORD = 'correct horse battery staple 7!';
const COUNTRY_CODE = 'TA';
const COUNTRY_B_CODE = 'TB';
const TENANT_A_CODE = 'T040A_E2E_TA';
const TENANT_B_CODE = 'T040A_E2E_TB';
const CAMPAIGN_A_CODE = 'T040A_E2E_CA';
const CAMPAIGN_B_CODE = 'T040A_E2E_CB';
const ADMIN_USER_EMAIL = 't040a-e2e@example.invalid';

let app: INestApplication;
let db: Sequelize;
let admin: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let countryAId: number;
let countryBId: number;
let tenantAId: number;
let tenantBId: number;
let campaignAId: number;
let campaignBId: number;
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
  const email = `t040a-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-040A ${key}`,
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

function get(key: string, path: string) {
  return http().get(`/api/v1${path}`).set('Cookie', as(key).jar);
}

function mutate(method: 'post' | 'patch' | 'delete', key: string, path: string) {
  return http()
    [method](`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send({});
}

// --- fixtures ------------------------------------------------------------------------------------

async function ensureCountry(code: string, name: string): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries WHERE code = :code',
    { code },
  );
  if (existing !== undefined) {
    await exec(`UPDATE reward_config.countries SET status = 'active' WHERE id = :id`, {
      id: existing.id,
    });
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
     VALUES (:code, :name, 'UTC', 'USD', '+001', 'active') RETURNING id`,
    { code, name },
  );
  return created.id;
}

async function ensureTenant(code: string, countryId: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.tenants WHERE code = :code',
    { code },
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
    { code, countryId },
  );
  return created.id;
}

async function ensureCampaign(code: string, tenantId: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.tenant_campaigns WHERE campaign_code = :code',
    { code },
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
     VALUES (:tenantId, :code, :code, 'EU', now(), now() + interval '30 days', 'draft', 't040a-e2e')
     RETURNING id`,
    { code, tenantId },
  );
  return created.id;
}

/** Mirrors `audit.e2e-spec.ts`/`trace.e2e-spec.ts`'s own fixture. */
async function ensureAdminUser(): Promise<number> {
  const [existing] = await adminSql<{ id: number }>(
    'SELECT id FROM reward_config.admin_users WHERE email = :email',
    { email: ADMIN_USER_EMAIL },
  );
  if (existing !== undefined) return existing.id;

  const [anyExisting] = await adminSql<{ id: number }>(
    'SELECT id FROM reward_config.admin_users ORDER BY id LIMIT 1',
  );
  if (anyExisting !== undefined) return anyExisting.id;

  const [key] = await adminSql<{ id: number }>(
    `INSERT INTO reward_config.tenant_api_keys (tenant_id, key_prefix, key_hash, status, expires_at)
     VALUES (:tenantId, 't040a', 'not-a-real-hash', 'active', now() + interval '1 day') RETURNING id`,
    { tenantId: tenantAId },
  );
  createdApiKeyId = key.id;

  const [created] = await adminSql<{ id: number }>(
    `INSERT INTO reward_config.admin_users (api_key_id, role, display_name, email, tenant_id, status)
     VALUES (:apiKeyId, 'tenant_admin', 'T-040 e2e fixture', :email, :tenantId, 'active') RETURNING id`,
    { apiKeyId: key.id, tenantId: tenantAId, email: ADMIN_USER_EMAIL },
  );
  createdAdminUser = true;
  return created.id;
}

// --- lifecycle -------------------------------------------------------------------------------

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), T056_SUITE);

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

  countryAId = await ensureCountry(COUNTRY_CODE, 'T-040 audit e2e country A');
  countryBId = await ensureCountry(COUNTRY_B_CODE, 'T-040 audit e2e country B');
  tenantAId = await ensureTenant(TENANT_A_CODE, countryAId);
  tenantBId = await ensureTenant(TENANT_B_CODE, countryBId);
  campaignAId = await ensureCampaign(CAMPAIGN_A_CODE, tenantAId);
  campaignBId = await ensureCampaign(CAMPAIGN_B_CODE, tenantBId);
  fixtureAdminUserId = await ensureAdminUser();

  await makeActor('super', 'super_admin', { countryId: null, tenantId: null, merchantId: null });
  await makeActor('country', 'country_admin', {
    countryId: countryAId,
    tenantId: null,
    merchantId: null,
  });
  await makeActor('tenant', 'tenant_admin', {
    countryId: countryAId,
    tenantId: tenantAId,
    merchantId: null,
  });
  await makeActor('checker', 'checker', {
    countryId: countryAId,
    tenantId: tenantAId,
    merchantId: null,
  });
  await makeActor('maker', 'maker', {
    countryId: countryAId,
    tenantId: tenantAId,
    merchantId: null,
  });

  // The domain-audit fixtures: written through the real `AuditService`, exactly the shape
  // T-014's own suite proves, so this suite's TC-21 (secrets scan) is testing real redaction
  // rather than a hand-picked clean value.
  const audit = app.get(AuditService);
  await audit.recordDomainEvent({
    tenantId: tenantAId,
    campaignId: campaignAId,
    entityType: 'campaign_submit',
    action: 'submitted',
    performedBy: fixtureAdminUserId,
    fieldChanges: {
      status: { before: 'draft', after: 'pending_approval' },
      // A field named like a secret is dropped entirely by `AuditService.diffFields`'s
      // redaction-listed-key rule when built through `diffFields` — this call passes a
      // pre-built object instead, precisely so the raw value here proves nothing on its own.
      // The real assertion (TC-21) is that `AuditService.redact()` — applied unconditionally to
      // every `fieldChanges` payload, not only ones built via `diffFields` — strips it before
      // the row is written, which this suite's own TC-21 test verifies against the row it reads
      // back, not against this fixture's intent.
      password: 'should-never-reach-the-table',
      apiToken: 'should-never-reach-the-table-either',
    },
    comment: '=cmd|/c calc — an injected CSV formula, planted deliberately for TC-19',
  });
  // TC-14's own fixture: a real row that exists, owned by tenant B, so the test that asks
  // tenant A's admin for it is proving cross-tenant *exclusion* rather than merely "there was
  // nothing to find either way".
  await audit.recordDomainEvent({
    tenantId: tenantBId,
    campaignId: campaignBId,
    entityType: 'campaign_submit',
    action: 'submitted',
    performedBy: fixtureAdminUserId,
  });
  await audit.recordPortalEvent({
    eventType: 'login_succeeded',
    actorId: fixtureAdminUserId,
    actorRole: 'tenant_admin',
    countryId: countryAId,
    tenantId: tenantAId,
    detail: { note: 'fixture row', password: 'should-never-reach-the-table' },
  });
});

afterAll(async () => {
  await exec(`DELETE FROM reward_portal.portal_users WHERE display_name LIKE 'T-040A %'`);
  await removeEncryptionKeys(db, T056_SUITE);
  await admin.query('DELETE FROM reward_config.campaign_audit_trail WHERE campaign_id IN (:ids)', {
    type: QueryTypes.RAW,
    replacements: { ids: [campaignAId, campaignBId] },
  });
  await admin.query(
    `DELETE FROM reward_portal.portal_audit_log WHERE tenant_id = :tenantId AND event_type = 'login_succeeded' AND detail->>'note' = 'fixture row'`,
    { type: QueryTypes.RAW, replacements: { tenantId: tenantAId } },
  );
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
  await app.close();
});

// --- the suite ---------------------------------------------------------------------------------

describe('T-040 — /audit/campaigns, /audit/portal', () => {
  describe('TC-10/TC-11/TC-12 — /audit/portal is super_admin only', () => {
    it('TC-10 — super_admin reads it', async () => {
      const response = await get('super', '/audit/portal').expect(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('TC-11 — country_admin is refused', async () => {
      await get('country', '/audit/portal').expect(403);
    });

    it('TC-12 — maker is refused', async () => {
      await get('maker', '/audit/portal').expect(403);
    });
  });

  describe('TC-13 — tenant_admin reads /audit/campaigns, only own-tenant entries', () => {
    it('sees the tenant A fixture row', async () => {
      const response = await get('tenant', '/audit/campaigns').expect(200);
      expect(response.body.data.length).toBeGreaterThan(0);
      for (const row of response.body.data) {
        expect(row.tenantId).toBe(tenantAId);
      }
    });

    it('checker (also granted audit:view) sees it too', async () => {
      await get('checker', '/audit/campaigns').expect(200);
    });
  });

  describe('negative authorisation — /audit/campaigns', () => {
    it('maker is refused (not granted audit:view)', async () => {
      await get('maker', '/audit/campaigns').expect(403);
    });
  });

  describe("TC-14 — tenant A's admin filters for tenant B's campaign", () => {
    it("a real, existing tenant-B campaign id answers empty — never another tenant's rows", async () => {
      // `campaignBId` is a genuine `tenant_campaigns` row, owned by tenant B — not a made-up
      // id. `tenant` only ever has tenant A in scope, so `ScopedRepository`'s own tenant
      // predicate (T-013) excludes it regardless of the `campaignId` filter matching a real row.
      const response = await get(
        'tenant',
        `/audit/campaigns?campaignId=${String(campaignBId)}`,
      ).expect(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.meta.total).toBe(0);
    });

    it('an id that matches nothing at all answers empty too', async () => {
      const response = await get(
        'tenant',
        `/audit/campaigns?campaignId=${String(campaignAId + 999_000)}`,
      ).expect(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.meta.total).toBe(0);
    });
  });

  describe('TC-15 — filters (date, actor, action)', () => {
    it('actorId + action narrows to the fixture row', async () => {
      const response = await get(
        'tenant',
        `/audit/campaigns?actorId=${String(fixtureAdminUserId)}&action=submitted`,
      ).expect(200);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.data.every((r: { action: string }) => r.action === 'submitted')).toBe(
        true,
      );
    });

    it('a date range that excludes now returns nothing', async () => {
      const response = await get(
        'tenant',
        '/audit/campaigns?dateFrom=2000-01-01T00:00:00.000Z&dateTo=2000-01-02T00:00:00.000Z',
      ).expect(200);
      expect(response.body.data).toEqual([]);
    });
  });

  describe('TC-16 — an injected column name is rejected', () => {
    it('an unknown query key on /audit/campaigns is a 400', async () => {
      const response = await get('tenant', '/audit/campaigns?orderByColumn=password_hash');
      expect(response.status).toBe(400);
    });

    it('an unknown query key on /audit/portal is a 400', async () => {
      const response = await get('super', '/audit/portal?orderByColumn=actor_id;DROP TABLE x');
      expect(response.status).toBe(400);
    });
  });

  describe('TC-17 — no mutating route exists on /audit at all', () => {
    it.each(['post', 'patch', 'delete'] as const)(
      '%s /audit/campaigns is a 404',
      async (method) => {
        const response = await mutate(method, 'tenant', '/audit/campaigns');
        expect(response.status).toBe(404);
      },
    );

    it.each(['post', 'patch', 'delete'] as const)('%s /audit/portal is a 404', async (method) => {
      const response = await mutate(method, 'super', '/audit/portal');
      expect(response.status).toBe(404);
    });
  });

  describe('TC-18/TC-19 — CSV export', () => {
    it('TC-18 — correct headers and rows', async () => {
      const response = await get('tenant', '/audit/campaigns/export').expect(200);
      expect(response.headers['content-type']).toContain('text/csv');
      const lines = (response.text as string).trim().split('\r\n');
      expect(lines[0]).toBe(
        'id,tenantId,campaignId,entityType,entityId,action,performedBy,performedAt,approvedBy,approvedAt,comment,fieldChanges',
      );
      expect(lines.length).toBeGreaterThan(1);
    });

    it("TC-19 — the planted `=cmd|…` comment is prefixed with ' in the exported cell", async () => {
      const response = await get('tenant', '/audit/campaigns/export').expect(200);
      expect(response.text).toContain("'=cmd|/c calc");
      // And never the raw, un-neutralised formula.
      expect(response.text).not.toMatch(/(?<!')=cmd\|\/c calc/);
    });

    it('the portal export carries the fixture login event for super_admin', async () => {
      const response = await get('super', '/audit/portal/export').expect(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.text).toContain('login_succeeded');
    });
  });

  describe('TC-21 — audit rows scanned for secrets', () => {
    it('no password, token or hash reaches the campaign-audit response', async () => {
      const response = await get('tenant', '/audit/campaigns').expect(200);
      const serialised = JSON.stringify(response.body);
      // The raw secret value must never appear, under any key.
      expect(serialised).not.toContain('should-never-reach-the-table');
      expect(serialised).not.toContain('should-never-reach-the-table-either');
      // `redact()` (T-014, `common/logging/redact.ts`) keeps a sensitive *key* name — it is not
      // itself secret, and the shape is useful to an investigator — but replaces its *value*
      // unconditionally with `[REDACTED]` at write time. `ResponseMaskingInterceptor` (T-017)
      // then applies a second, independent pass over the response, which for a field name with
      // its own `ui_visibility: never` policy removes the key entirely rather than masking it —
      // a stronger, not weaker, outcome. Either shape is safe; what is never acceptable is the
      // key surviving with anything other than the redacted marker as its value.
      const fieldChanges = (response.body.data as { fieldChanges: Record<string, unknown> }[])[0]
        ?.fieldChanges;
      for (const key of ['password', 'apiToken']) {
        expect([undefined, '[REDACTED]']).toContain(fieldChanges?.[key]);
      }
    });

    it('no password reaches the portal-audit response', async () => {
      const response = await get('super', '/audit/portal').expect(200);
      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain('should-never-reach-the-table');
    });

    it('no password reaches the CSV export either', async () => {
      const response = await get('tenant', '/audit/campaigns/export').expect(200);
      expect(response.text).not.toContain('should-never-reach-the-table');
    });
  });
});
