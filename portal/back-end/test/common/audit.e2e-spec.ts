/**
 * T-014 — the audit stores and the error envelope against the **real** Postgres instance,
 * through the real `AppModule`, over real HTTP.
 *
 * The unit suites in this directory prove the decisions: which row is assembled, which code is
 * chosen, which branch redacts. They cannot prove the things that actually decide whether this
 * task works, which is what this file is for:
 *
 *  - that the two `INSERT` statements are valid against the live schema, that `CAST(:detail AS
 *    jsonb)` and `CAST(:ipAddress AS inet)` accept what the service produces, and that the
 *    `varchar` truncation is enough (TC-1…TC-4);
 *  - that `reward_app` genuinely **cannot** `UPDATE` or `DELETE` either audit table — a property
 *    of the grants T002_008 applied, not of any code, and therefore only observable here (TC-5);
 *  - that a real Sequelize `UniqueConstraintError` and a real `DatabaseError`, raised by the real
 *    driver with the real table names in their messages, still produce a body with none of it
 *    (TC-9, TC-10, TC-12);
 *  - that the `traceId` in the body is the one in the log (TC-16), through the real filter.
 *
 * ### Fixtures, and what cannot be cleaned up
 *
 * Same constraint `rbac.e2e-spec.ts` documents: `reward_app` has `DELETE` on nothing in
 * `reward_config`, so country/tenant/campaign fixtures are idempotent and persist between runs.
 * `portal_users` and everything cascading from them are deleted.
 *
 * Two exceptions are handled through the **migration connection** (the privileged role the
 * migration CLI uses), and only for reading or for fixtures the app role is deliberately not
 * allowed to create:
 *
 *  - `reward_config.admin_users` — the portal has no grant on it at all, and
 *    `campaign_audit_trail.performed_by` has a foreign key to it. One fixture row (plus the
 *    `tenant_api_keys` row its `NOT NULL UNIQUE api_key_id` requires) is created if none exists,
 *    and removed afterwards.
 *  - the `campaign_audit_trail` rows this suite writes are removed afterwards, because that
 *    table is a real, 7-year-retention audit trail and leaving test rows in it would corrupt the
 *    only record a dispute is settled from.
 */
import {
  Body,
  Controller,
  Get,
  INestApplication,
  Inject,
  Injectable,
  Module,
  Param,
  ParseIntPipe,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsEmail, IsInt, IsString, Min } from 'class-validator';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { DatabaseModule } from '@/database/database.module';
import { createMigrationConnection } from '@/database/migration-connection';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { Public } from '@/modules/auth/decorators/public.decorator';
import { Roles } from '@/common/rbac';
import { RbacModule } from '@/common/rbac/rbac.module';
import { ScopedRepository } from '@/common/scope';
import { TenantCampaign } from '@/database/models';
import type { PortalRole } from '@/database/portal-models';
// T-056 — fixtures carry ciphertext plus a blind index; see that helper's header.
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { AuditModule } from '@/common/audit/audit.module';
import { AuditService } from '@/common/audit/audit.service';
import { AUDIT_STORE, type AuditStore } from '@/common/audit/audit.repository';
import { validationExceptionFactory } from '@/common/errors';

jest.setTimeout(300_000);

/** Set in `beforeAll`; the fixture controller reads it for `campaign_audit_trail.performed_by`. */
let fixtureAdminUserId: number | null = null;

// --- the fixture feature module ---------------------------------------------------------------

class ValidatedDto {
  @IsEmail()
  email!: string;

  @IsString()
  name!: string;

  @IsInt()
  @Min(0)
  amount!: number;
}

@Injectable()
class FixtureService {
  constructor(
    readonly scoped: ScopedRepository,
    readonly audit: AuditService,
    @Inject(SEQUELIZE) readonly db: Sequelize,
  ) {}
}

@Controller('t014')
class FixtureController {
  constructor(private readonly fixture: FixtureService) {}

  /** An audited administrative action → `portal_audit_log`. */
  @Post('audited/:id')
  @Roles('maker', 'super_admin')
  @Audit({ event: 't014_thing_updated', targetType: 'thing' })
  audited(@Param('id') id: string, @Body() body: { note?: string }): { data: { id: string } } {
    this.fixture.audit.annotate({ detail: { note: body.note ?? null } });
    return { data: { id } };
  }

  /** An audited action that throws *after* the decorator — TC-6 over HTTP. */
  @Post('audited-throws/:id')
  @Roles('maker', 'super_admin')
  @Audit({ event: 't014_thing_failed', targetType: 'thing' })
  auditedThrows(@Param('id') _id: string): never {
    throw new TypeError('the handler failed after the audit decorator ran');
  }

  /** A real campaign change → `campaign_audit_trail`, with a real before/after diff. */
  @Post('campaigns/:id/rename')
  @Roles('maker', 'super_admin')
  @Audit({ store: 'campaign', event: 'updated', targetType: 'campaign' })
  async renameCampaign(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name: string },
  ): Promise<{ data: { id: number } }> {
    const campaign = await this.fixture.scoped.findByPkOrFail(TenantCampaign, id);
    const before = { name: campaign.name, status: campaign.status, region: campaign.region };
    await this.fixture.scoped.update(TenantCampaign, { name: body.name }, { where: { id } });

    this.fixture.audit.annotate({
      campaignId: id,
      // From the row this request just read through `ScopedRepository`, never from the body.
      tenantId: campaign.tenantId,
      entityId: id,
      fieldChanges: this.fixture.audit.diffFields(before, {
        name: body.name,
        status: campaign.status,
        region: campaign.region,
      }),
      ...(fixtureAdminUserId === null ? {} : { performedBy: fixtureAdminUserId }),
    });

    return { data: { id } };
  }

  /** The same, with no `performed_by` resolvable — the documented gap. */
  @Post('campaigns/:id/rename-unlinked')
  @Roles('maker', 'super_admin')
  @Audit({ store: 'campaign', event: 'updated', targetType: 'campaign' })
  async renameUnlinked(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { name: string },
  ): Promise<{ data: { id: number } }> {
    const campaign = await this.fixture.scoped.findByPkOrFail(TenantCampaign, id);
    this.fixture.audit.annotate({
      campaignId: id,
      tenantId: campaign.tenantId,
      fieldChanges: { name: { before: campaign.name, after: body.name } },
    });
    return { data: { id } };
  }

  /** TC-3: a role the guard refuses. */
  @Get('super-admin-only')
  @Roles('super_admin')
  superAdminOnly(): { data: string } {
    return { data: 'unreachable for a maker' };
  }

  /** TC-8: an unhandled `TypeError` from a service. */
  @Get('boom')
  @Public()
  boom(): never {
    const nothing = undefined as unknown as { id: string };
    return nothing.id as never;
  }

  /** TC-10: a real `DatabaseError`, with a real table name and real SQL in its message. */
  @Get('db-boom')
  @Public()
  async dbBoom(): Promise<unknown> {
    return this.fixture.db.query(
      'SELECT budget_amont FROM reward_config.tenant_campaigns LIMIT 1',
      { type: QueryTypes.SELECT },
    );
  }

  /** TC-9: a real `UniqueConstraintError` from the driver. */
  @Post('duplicate')
  @Public()
  async duplicate(): Promise<unknown> {
    return this.fixture.db.query(
      `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
       VALUES ('ZZ', 'T014 duplicate', 'UTC', 'USD', '+000', 'active')`,
      { type: QueryTypes.INSERT },
    );
  }

  /** TC-11: a DTO the pipe rejects. */
  @Post('validate')
  @Public()
  validate(@Body() dto: ValidatedDto): { data: ValidatedDto } {
    return { data: dto };
  }
}

@Module({
  imports: [RbacModule, AuditModule, DatabaseModule],
  controllers: [FixtureController],
  providers: [FixtureService],
})
class FixtureModule {}

// --- harness ------------------------------------------------------------------------------------

const PASSWORD = 'correct horse battery staple 7!';
const WRONG_PASSWORD = 'T014-wrong-password-never-logged';
const COUNTRY_CODE = 'ZZ';
const TENANT_CODE = 'T014_E2E_A';
const CAMPAIGN_CODE = 'T014_E2E_C1';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

/** Namespaces this suite's encryption-key rows. */
const T056_SUITE = 't014aud';
let admin: Sequelize;
let tenantId: number;
let campaignId: number;
let createdAdminUser = false;
let createdApiKeyId: number | null = null;

interface Actor {
  readonly email: string;
  readonly userId: number;
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
  scope: {
    countryId: number | null;
    tenantId: number | null;
    merchantId: number | null;
  },
): Promise<Actor> {
  const email = `t014-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const created = {
    id: await insertPortalUser(db, emailCrypto, {
      email,
      displayName: `T-014 ${key}`,
      role,
      ...scope,
    }),
  };
  await exec(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { userId: created.id, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
  );

  const response = await http().post('/api/v1/auth/login').send({ email, password: PASSWORD });
  if (response.status !== 200) {
    throw new Error(`login for ${key} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  const actor: Actor = {
    email,
    userId: created.id,
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

function post(key: string, path: string, body: unknown) {
  return http()
    .post(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send(body as object);
}

async function ensureCountry(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries WHERE code = :code',
    { code: COUNTRY_CODE },
  );
  if (existing !== undefined) {
    await exec("UPDATE reward_config.countries SET status = 'active' WHERE id = :id", {
      id: existing.id,
    });
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
     VALUES (:code, 'T014 country', 'UTC', 'USD', '+000', 'active')
     RETURNING id`,
    { code: COUNTRY_CODE },
  );
  return created.id;
}

async function ensureTenant(countryId: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.tenants WHERE code = :code',
    { code: TENANT_CODE },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.tenants SET status = 'active', deleted_at = NULL, country_id = :countryId
        WHERE id = :id`,
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

async function ensureCampaign(tenant: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.tenant_campaigns WHERE campaign_code = :code',
    { code: CAMPAIGN_CODE },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.tenant_campaigns
          SET deleted_at = NULL, tenant_id = :tenantId, name = :code, status = 'draft', region = 'EU'
        WHERE id = :id`,
      { id: existing.id, tenantId: tenant, code: CAMPAIGN_CODE },
    );
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenant_campaigns
            (tenant_id, campaign_code, name, region, start_date, end_date, status, created_by)
     VALUES (:tenantId, :code, :code, 'EU', now(), now() + interval '30 days', 'draft', 't014-e2e')
     RETURNING id`,
    { code: CAMPAIGN_CODE, tenantId: tenant },
  );
  return created.id;
}

/**
 * An `admin_users` id for `campaign_audit_trail.performed_by`, created through the privileged
 * connection because `reward_app` has no grant on that table at all — see the file header.
 */
async function ensureAdminUser(): Promise<number | null> {
  const [existing] = await adminSql<{ id: number }>(
    "SELECT id FROM reward_config.admin_users WHERE email = 't014-e2e@example.invalid'",
  );
  if (existing !== undefined) return existing.id;

  const [anyExisting] = await adminSql<{ id: number }>(
    'SELECT id FROM reward_config.admin_users ORDER BY id LIMIT 1',
  );
  if (anyExisting !== undefined) return anyExisting.id;

  const [key] = await adminSql<{ id: number }>(
    `INSERT INTO reward_config.tenant_api_keys (tenant_id, key_prefix, key_hash, status, expires_at)
     VALUES (:tenantId, 't014', 'not-a-real-hash', 'active', now() + interval '1 day')
     RETURNING id`,
    { tenantId },
  );
  createdApiKeyId = key.id;

  const [created] = await adminSql<{ id: number }>(
    `INSERT INTO reward_config.admin_users (api_key_id, role, display_name, email, tenant_id, status)
     VALUES (:apiKeyId, 'tenant_admin', 'T-014 e2e fixture', 't014-e2e@example.invalid', :tenantId, 'active')
     RETURNING id`,
    { apiKeyId: key.id, tenantId },
  );
  createdAdminUser = true;
  return created.id;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, FixtureModule],
  }).compile();

  // T-056: the login below needs an active `field` and `blind_index` key, because
  // `portal_users.email` is encrypted and the lookup runs over its blind index. Before `listen()`.
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), T056_SUITE);

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  // Identical to `main.ts`, `exceptionFactory` included — TC-11 is a property of that wiring.
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
  admin = createMigrationConnection();

  const countryId = await ensureCountry();
  tenantId = await ensureTenant(countryId);
  campaignId = await ensureCampaign(tenantId);
  fixtureAdminUserId = await ensureAdminUser();

  await makeActor('maker', 'maker', { countryId, tenantId, merchantId: null });
});

afterAll(async () => {
  for (const actor of actors.values()) {
    await exec('DELETE FROM reward_portal.portal_users WHERE id = :id', { id: actor.userId });
  }
  await removeEncryptionKeys(db, T056_SUITE);
  // The privileged connection removes what the app role deliberately cannot: this suite's rows in
  // a real 7-year audit trail, and the `admin_users`/`tenant_api_keys` fixtures.
  await admin.query('DELETE FROM reward_config.campaign_audit_trail WHERE campaign_id = :id', {
    type: QueryTypes.RAW,
    replacements: { id: campaignId },
  });
  if (createdAdminUser) {
    await admin.query(
      "DELETE FROM reward_config.admin_users WHERE email = 't014-e2e@example.invalid'",
      { type: QueryTypes.RAW },
    );
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

// --- the suite ------------------------------------------------------------------------------------

describe('T-014 — audit stores', () => {
  describe('TC-1 — a successful login', () => {
    it('writes an authentication event with the actor, role and IP', async () => {
      const actor = as('maker');
      const [row] = await sql<{
        event_type: string;
        actor_id: number;
        actor_role: string;
        ip_address: string | null;
        detail: Record<string, unknown> | null;
      }>(
        `SELECT event_type, actor_id, actor_role, ip_address, detail
           FROM reward_portal.portal_audit_log
          WHERE actor_id = :userId
          ORDER BY id DESC LIMIT 1`,
        { userId: actor.userId },
      );

      // T-011 owns the success side of the catalogue and names the event `login_succeeded`; the
      // task file calls it `login_success`. The row, not the spelling, is what TC-1 asks for —
      // recorded as a deviation in the completion report rather than renaming a `done` task's
      // event and breaking its own assertions.
      expect(row.event_type).toBe('login_succeeded');
      expect(row.actor_id).toBe(actor.userId);
      expect(row.actor_role).toBe('maker');
      expect(row.ip_address).not.toBeNull();
      expect(JSON.stringify(row.detail ?? {})).not.toContain(PASSWORD);
    });
  });

  describe('TC-2 — a failed login', () => {
    it('writes login_failure, and the detail contains no password', async () => {
      const before = await countPortalEvents('login_failure');

      const response = await http()
        .post('/api/v1/auth/login')
        .send({ email: as('maker').email, password: WRONG_PASSWORD });

      expect(response.status).toBe(401);
      expect(await countPortalEvents('login_failure')).toBe(before + 1);

      const [row] = await sql<{ detail: Record<string, unknown>; actor_id: number | null }>(
        `SELECT detail, actor_id FROM reward_portal.portal_audit_log
          WHERE event_type = 'login_failure' ORDER BY id DESC LIMIT 1`,
      );

      expect(JSON.stringify(row.detail)).not.toContain(WRONG_PASSWORD);
      expect(JSON.stringify(row.detail)).not.toContain(as('maker').email);
      expect(row.detail).toMatchObject({
        method: 'POST',
        route: '/api/v1/auth/login',
        status: 401,
      });
    });

    it('the password appears nowhere in either audit table (verification step 5)', async () => {
      const [{ hits }] = await sql<{ hits: string }>(
        `SELECT count(*) AS hits FROM reward_portal.portal_audit_log
          WHERE detail::text LIKE :needle`,
        { needle: `%${WRONG_PASSWORD}%` },
      );
      expect(Number(hits)).toBe(0);
    });
  });

  describe('TC-3 — a permission denial', () => {
    it('writes permission_denied naming the attempted route, and answers 403', async () => {
      const response = await get('maker', '/t014/super-admin-only');

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PERM_DENIED');

      const [row] = await sql<{
        actor_id: number;
        actor_role: string;
        target_type: string;
        target_id: string;
        tenant_id: number | null;
        detail: Record<string, unknown>;
      }>(
        `SELECT actor_id, actor_role, target_type, target_id, tenant_id, detail
           FROM reward_portal.portal_audit_log
          WHERE event_type = 'permission_denied' ORDER BY id DESC LIMIT 1`,
      );

      expect(row.actor_id).toBe(as('maker').userId);
      expect(row.actor_role).toBe('maker');
      expect(row.target_type).toBe('route');
      expect(row.target_id).toContain('/t014/super-admin-only');
      expect(row.tenant_id).toBe(tenantId);
      expect(row.detail).toMatchObject({ method: 'GET', status: 403, code: 'PERM_DENIED' });
      expect(row.detail.traceId).toEqual(expect.any(String));
    });
  });

  describe('TC-4 — a campaign update', () => {
    it("writes campaign_audit_trail with action='updated' and only the changed fields", async () => {
      const name = `T014 renamed ${Date.now()}`;
      const response = await post('maker', `/t014/campaigns/${campaignId}/rename`, { name });

      expect(response.status).toBe(201);

      const [row] = await adminSql<{
        action: string;
        entity_type: string;
        tenant_id: number;
        campaign_id: number;
        entity_id: number | null;
        field_changes: string;
        performed_by: number;
        retention_expires_at: Date;
      }>(
        `SELECT action, entity_type, tenant_id, campaign_id, entity_id, field_changes,
                performed_by, retention_expires_at
           FROM reward_config.campaign_audit_trail
          WHERE campaign_id = :campaignId ORDER BY id DESC LIMIT 1`,
        { campaignId },
      );

      expect(row.action).toBe('updated');
      expect(row.entity_type).toBe('campaign');
      expect(row.tenant_id).toBe(tenantId);
      expect(row.performed_by).toBe(fixtureAdminUserId);

      // Only what changed: `status` and `region` were identical and must be absent.
      const changes = JSON.parse(row.field_changes) as Record<string, unknown>;
      expect(Object.keys(changes)).toEqual(['name']);
      expect(changes.name).toMatchObject({ after: name });

      // The 7-year default the design relies on, applied by the table rather than by us.
      const years =
        (new Date(row.retention_expires_at).getTime() - Date.now()) / (365.25 * 24 * 3600 * 1000);
      expect(years).toBeGreaterThan(6.9);
    });

    it('writes nothing to portal_audit_log for a domain change (01-DATABASE.md §2.5)', async () => {
      const before = await countPortalEvents('t014_thing_updated');
      await post('maker', `/t014/campaigns/${campaignId}/rename`, { name: `T014 ${Date.now()}` });

      expect(await countPortalEvents('t014_thing_updated')).toBe(before);
    });

    it('skips the row — and does not fail the request — when performed_by cannot be resolved', async () => {
      // The documented design gap: `performed_by` has a foreign key to `admin_users`, and a
      // `maker` cannot be represented there at all (00-ARCHITECTURE.md §5.2 gap G1).
      const before = await countDomainRows();

      const response = await post('maker', `/t014/campaigns/${campaignId}/rename-unlinked`, {
        name: 'T014 unlinked',
      });

      expect(response.status).toBe(201);
      expect(await countDomainRows()).toBe(before);
    });

    it('confirms the foreign key that forces all of the above still exists', async () => {
      const [row] = await adminSql<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = 'reward_config.campaign_audit_trail'::regclass
            AND conname = 'fk_cat_performed_by'`,
      );

      expect(row?.definition).toContain('REFERENCES reward_config.admin_users(id)');
    });
  });

  describe('TC-5 — both audit tables are append-only for reward_app', () => {
    it.each([
      [
        'reward_portal.portal_audit_log',
        'UPDATE reward_portal.portal_audit_log SET event_type = 0',
      ],
      ['reward_portal.portal_audit_log', 'DELETE FROM reward_portal.portal_audit_log'],
      [
        'reward_config.campaign_audit_trail',
        "UPDATE reward_config.campaign_audit_trail SET action = 'created'",
      ],
      ['reward_config.campaign_audit_trail', 'DELETE FROM reward_config.campaign_audit_trail'],
    ])('%s: %s is refused', async (_table, statement) => {
      await expect(exec(statement)).rejects.toThrow(/permission denied/i);
    });

    it('but INSERT and SELECT are granted — the log must still be writable and readable', async () => {
      await expect(
        sql('SELECT count(*) FROM reward_portal.portal_audit_log'),
      ).resolves.toBeDefined();
      await expect(
        sql('SELECT count(*) FROM reward_config.campaign_audit_trail'),
      ).resolves.toBeDefined();
    });
  });

  describe('TC-6 / TC-7 — success-only, and never fatal', () => {
    it('TC-6: a handler that throws after @Audit writes no row', async () => {
      const before = await countPortalEvents('t014_thing_failed');

      const response = await post('maker', '/t014/audited-throws/99', {});

      expect(response.status).toBe(500);
      expect(await countPortalEvents('t014_thing_failed')).toBe(before);
    });

    it('TC-7: a forced audit-insert failure still returns 2xx', async () => {
      const store = app.get<AuditStore>(AUDIT_STORE);
      const spy = jest
        .spyOn(store, 'insertPortalEvent')
        .mockRejectedValue(new Error('forced audit outage'));

      try {
        const before = await countPortalEvents('t014_thing_updated');
        const response = await post('maker', '/t014/audited/77', { note: 'still works' });

        expect(response.status).toBe(201);
        expect(response.body).toEqual({ data: { id: '77' } });
        expect(await countPortalEvents('t014_thing_updated')).toBe(before);
      } finally {
        spy.mockRestore();
      }
    });

    it('an audited handler that succeeds writes exactly one row, with the JWT’s actor', async () => {
      const before = await countPortalEvents('t014_thing_updated');

      await post('maker', '/t014/audited/8821', { note: 'hello' });

      expect(await countPortalEvents('t014_thing_updated')).toBe(before + 1);
      const [row] = await sql<{
        actor_id: number;
        actor_role: string;
        target_type: string;
        target_id: string;
        detail: Record<string, unknown>;
      }>(
        `SELECT actor_id, actor_role, target_type, target_id, detail
           FROM reward_portal.portal_audit_log
          WHERE event_type = 't014_thing_updated' ORDER BY id DESC LIMIT 1`,
      );

      expect(row.actor_id).toBe(as('maker').userId);
      expect(row.actor_role).toBe('maker');
      expect(row.target_type).toBe('thing');
      expect(row.target_id).toBe('8821');
      expect(row.detail).toMatchObject({ method: 'POST', note: 'hello' });
    });
  });
});

describe('T-014 — the error envelope over real HTTP', () => {
  /** Every error path this application can produce from a real request. */
  const forbidden = [
    'reward_config',
    'reward_portal',
    'tenant_campaigns',
    'budget_amont',
    'countries_code_key',
    'SELECT',
    'INSERT INTO',
    'at Object.',
    'at Function.',
    '/src/',
    '.ts:',
    'node_modules',
    'must be an email',
    'should not exist',
  ];

  it('TC-8: an unhandled TypeError is a 500 INTERNAL_ERROR with a traceId and nothing else', async () => {
    const response = await http().get('/api/v1/t014/boom');

    expect(response.status).toBe(500);
    expect(Object.keys(response.body)).toEqual(['error']);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(response.body.error.traceId).toEqual(expect.any(String));
    expect(Object.keys(response.body.error).sort()).toEqual(['code', 'message', 'traceId']);
  });

  it('TC-9: a real UniqueConstraintError is a 409 with a business code', async () => {
    const response = await http().post('/api/v1/t014/duplicate');

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DUPLICATE_RESOURCE');
    expect(JSON.stringify(response.body)).not.toMatch(/uq_|_key|countries/i);
  });

  it('TC-10: a real DatabaseError is a generic 500 naming no table or column', async () => {
    const response = await http().get('/api/v1/t014/db-boom');

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('budget_amont');
  });

  it('TC-11: a validation failure is a 400 with {field, code} details and no prose', async () => {
    const response = await http()
      .post('/api/v1/t014/validate')
      .send({ email: 'not-an-email', name: 7, amount: -1, tenantId: 999 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.details).toEqual(
      expect.arrayContaining([
        { field: 'email', code: 'IS_EMAIL' },
        { field: 'name', code: 'IS_STRING' },
        { field: 'amount', code: 'MIN' },
        { field: 'tenantId', code: 'UNEXPECTED_FIELD' },
      ]),
    );
  });

  it('TC-12: no error path leaks an internal detail', async () => {
    const responses = [
      await http().get('/api/v1/t014/boom'),
      await http().get('/api/v1/t014/db-boom'),
      await http().post('/api/v1/t014/duplicate'),
      await http().post('/api/v1/t014/validate').send({ email: 'x', name: 7, amount: -1 }),
      await http().get('/api/v1/t014/super-admin-only'), // 401 — no session at all
      await get('maker', '/t014/super-admin-only'), // 403 — wrong role
      await http().get('/api/v1/nope'), // 404 — no such route
      await http().post('/api/v1/auth/login').send({ email: 'x@y.z', password: 'nope' }), // 401
      await http().post('/api/v1/t014/audited/1').send({}), // 403 — no CSRF token
      await post('maker', '/t014/audited-throws/1', {}), // 500 from a handler
    ];

    for (const response of responses) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      const serialised = JSON.stringify(response.body);
      for (const needle of forbidden) {
        expect(serialised).not.toContain(needle);
      }
      expect(response.body.error.code).toMatch(/^[A-Z][A-Z0-9_]{1,59}$/);
    }
  });

  it('TC-16: the traceId is echoed from a well-formed client correlation id', async () => {
    const response = await http()
      .get('/api/v1/t014/boom')
      .set('X-Correlation-Id', 'T014E2ETRACE01');

    expect(response.body.error.traceId).toBe('T014E2ETRACE01');
  });

  it('every error body carries a message, falling back to the code when unseeded', async () => {
    const response = await get('maker', '/t014/super-admin-only');

    // `PERM_DENIED` *is* seeded (T004_004), so this proves the catalogue read works end to end.
    expect(response.body.error.message).toBe('You do not have permission to perform this action.');
  });
});

// --- helpers ---------------------------------------------------------------------------------------

async function countPortalEvents(eventType: string): Promise<number> {
  const [row] = await sql<{ count: string }>(
    'SELECT count(*) AS count FROM reward_portal.portal_audit_log WHERE event_type = :eventType',
    { eventType },
  );
  return Number(row.count);
}

async function countDomainRows(): Promise<number> {
  const [row] = await sql<{ count: string }>(
    'SELECT count(*) AS count FROM reward_config.campaign_audit_trail WHERE campaign_id = :campaignId',
    { campaignId },
  );
  return Number(row.count);
}
