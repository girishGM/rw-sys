/**
 * T-013 — the RBAC and tenancy-scope chain against the **real** Postgres instance, through the
 * real `AppModule`, over real HTTP.
 *
 * The unit suites in this directory prove the *decisions*: which clause is built, which branch
 * denies, which options object reaches Sequelize. They cannot prove the thing that actually
 * matters, which is that the resulting SQL returns the right rows from the real schema. In
 * particular they cannot prove:
 *
 *  - that `tenant_id IN (SELECT id FROM tenants WHERE country_id = :rsScope0)` is valid Postgres,
 *    that Sequelize really does substitute `options.replacements` into a `literal()` inside a
 *    `where`, and that the substituted value is escaped rather than concatenated (TC-8);
 *  - that a cross-tenant `PATCH` leaves the target row **byte-identical**, `updated_at` included
 *    (TC-7, verification step 5);
 *  - that a suspended tenant invalidates a live session on its next request with no bulk revoke
 *    having run (TC-23/TC-24);
 *  - that 500 interleaved mixed-tenant requests through the whole chain — guards, interceptor,
 *    connection pool, real queries — never cross a tenant boundary (TC-22).
 *
 * ### Fixtures, and what cannot be cleaned up
 *
 * All fixtures are prefixed `T013_E2E` / `t013-e2e` and are **idempotent**: a second run reuses
 * what the first created. That is not a convenience, it is forced by the least-privilege grants
 * of T002_008 — `reward_app` has `DELETE` on nothing in `reward_config` (01-DATABASE.md §3,
 * "the portal soft-deletes"). So, exactly as `auth.e2e-spec.ts` documents for its own fixture
 * tenant:
 *
 *  - the fixture **country**, **tenants**, **merchants** and **campaign_merchants** rows persist
 *    between runs. Campaigns are soft-deleted (`deleted_at`); the rest are set `inactive` at the
 *    end and are inert — nothing outside this suite references them.
 *  - `portal_users` and everything cascading from them (sessions, credentials, tokens) *are*
 *    deleted, because `reward_portal` grants allow it.
 *
 * ### Why the routes under test live here
 *
 * Wave 3 owns the real feature endpoints, and none of them exist yet. Rather than wait, this
 * file mounts a small controller of its own that uses the same decorators and the same
 * `ScopedRepository` a Wave 3 controller will — so the chain is exercised end to end today, and
 * the fixture controller doubles as the worked example those tasks copy from.
 */
import {
  Body,
  Controller,
  Get,
  INestApplication,
  Injectable,
  Module,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsInt, IsOptional, IsString } from 'class-validator';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { Public } from '@/modules/auth/decorators/public.decorator';
import { Tenant, TenantCampaign } from '@/database/models';
import { RbacModule } from '@/common/rbac/rbac.module';
import { RequirePermission, Roles, assertRole } from '@/common/rbac';
import { ScopeViolationError, ScopedRepository } from '@/common/scope';
// T-014 — the error envelope these assertions describe is now built by
// `ErrorNormalizationFilter`. See `test/common/support/error-envelope.ts` for why this suite
// changed and why the replacement is stricter, not looser.
import { expectErrorEnvelope, withoutTraceId } from '../common/support/error-envelope';
// T-055 — a `super_admin` login now ends in an MFA challenge; this completes it through the real
// endpoints. See the helper's own header for why it is not a session-minting shortcut.
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
// T-056 — fixtures are inserted through the application's own email crypto; see that file's header.
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import type { PortalRole } from '@/database/portal-models';

jest.setTimeout(300_000);

/** Namespaces this suite's `encryption_keys` row, so two suites cannot delete each other's. */
const MFA_SUITE = 't013';

// --- the fixture feature module -----------------------------------------------------------------

class CreateCampaignDto {
  @IsString()
  name!: string;

  /**
   * Deliberately accepted, which is the *wrong* thing for a real DTO to do (AGENT-PROTOCOL R3,
   * and `forbidNonWhitelisted` would otherwise reject it — asserted separately below).
   *
   * It is here so TC-14's second half is testable: even when the validation layer is misconfigured
   * and a client-supplied `tenantId` reaches the service, `ScopedRepository.create` overwrites it
   * from the verified scope. Two independent controls, and this route removes the first one to
   * prove the second works alone.
   */
  @IsOptional()
  @IsInt()
  tenantId?: number;
}

class StrictCreateCampaignDto {
  @IsString()
  name!: string;
}

class PatchCampaignDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  tenantId?: number;
}

@Injectable()
class FixtureService {
  constructor(readonly scoped: ScopedRepository) {}

  /**
   * The service-layer assertion of 00-ARCHITECTURE.md §5.2 / T-013 note 7, in the position Wave 3
   * must put it: first line of the service method, independent of `role_entity_permissions`.
   */
  createRule(actor: AuthenticatedUser): { ok: true } {
    assertRole(actor, 'super_admin');
    return { ok: true };
  }
}

@Controller('t013')
class FixtureController {
  constructor(private readonly fixture: FixtureService) {}

  @Get('campaigns')
  @Roles('super_admin', 'country_admin', 'tenant_admin', 'maker', 'checker', 'merchant')
  @RequirePermission('campaign', 'view')
  async listCampaigns(): Promise<{ data: { id: number; tenantId: number }[]; total: number }> {
    const rows = await this.fixture.scoped.findAll(TenantCampaign, { order: [['id', 'ASC']] });
    return {
      data: rows.map((row) => ({ id: row.id, tenantId: row.tenantId })),
      total: await this.fixture.scoped.count(TenantCampaign),
    };
  }

  @Get('campaigns/:id')
  @Roles('super_admin', 'country_admin', 'tenant_admin', 'maker', 'checker', 'merchant')
  @RequirePermission('campaign', 'view')
  async getCampaign(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ data: { id: number; tenantId: number; name: string } }> {
    const row = await this.fixture.scoped.findByPkOrFail(TenantCampaign, id);
    return { data: { id: row.id, tenantId: row.tenantId, name: row.name } };
  }

  @Patch('campaigns/:id')
  @Roles('maker', 'tenant_admin', 'super_admin')
  @RequirePermission('campaign', 'update')
  async patchCampaign(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PatchCampaignDto,
  ): Promise<{ data: { updated: number } }> {
    const updated = await this.fixture.scoped.update(TenantCampaign, dto, { where: { id } });
    // The 404 that makes a cross-tenant write indistinguishable from a missing row (TC-7).
    if (updated === 0) throw new ScopeViolationError();
    return { data: { updated } };
  }

  @Post('campaigns')
  @Roles('maker')
  @RequirePermission('campaign', 'create')
  async createCampaign(@Body() dto: CreateCampaignDto): Promise<{ data: { id: number } }> {
    const now = new Date();
    const row = await this.fixture.scoped.create(TenantCampaign, {
      // `tenantId` from the DTO is passed straight through on purpose — see CreateCampaignDto.
      tenantId: dto.tenantId,
      campaignCode: `T013_E2E_${now.getTime()}`,
      name: dto.name,
      startDate: now,
      endDate: new Date(now.getTime() + 86_400_000),
      status: 'draft',
      createdBy: 't013-e2e',
    } as never);
    return { data: { id: row.id } };
  }

  @Post('campaigns/strict')
  @Roles('maker')
  @RequirePermission('campaign', 'create')
  createCampaignStrict(@Body() _dto: StrictCreateCampaignDto): { data: { ok: true } } {
    return { data: { ok: true } };
  }

  @Get('tenants')
  @Roles('super_admin', 'country_admin', 'tenant_admin', 'maker', 'checker', 'merchant')
  @RequirePermission('tenant', 'view')
  async listTenants(): Promise<{ data: number[] }> {
    const rows = await this.fixture.scoped.findAll(Tenant, { order: [['id', 'ASC']] });
    return { data: rows.map((row) => row.id) };
  }

  @Get('tenants/:id')
  @Roles('super_admin', 'country_admin', 'tenant_admin', 'maker', 'checker', 'merchant')
  @RequirePermission('tenant', 'view')
  async getTenant(@Param('id', ParseIntPipe) id: number): Promise<{ data: { id: number } }> {
    const row = await this.fixture.scoped.findByPkOrFail(Tenant, id);
    return { data: { id: row.id } };
  }

  /**
   * TC-19's control: gated on `rule:create`, which the seeded matrix grants `super_admin` only.
   * A `maker` is stopped at layer 2 here, before the service is reached.
   */
  @Post('rules')
  @Roles('super_admin', 'maker')
  @RequirePermission('rule', 'create')
  createRule(@CurrentUser() actor: AuthenticatedUser): { data: { ok: true } } {
    return { data: this.fixture.createRule(actor) };
  }

  /**
   * TC-19 proper: gated on `campaign:create`, which the seeded matrix **does** grant `maker`.
   * Both guard layers therefore admit the request, and only `assertRole` refuses it — with no
   * edit to `role_entity_permissions` anywhere. See the TC-19 describe block.
   */
  @Post('rules-as-campaign-create')
  @Roles('super_admin', 'maker')
  @RequirePermission('campaign', 'create')
  createRuleBehindACampaignGrant(@CurrentUser() actor: AuthenticatedUser): { data: { ok: true } } {
    return { data: this.fixture.createRule(actor) };
  }

  /** TC-18: shipped without a decorator. */
  @Get('unguarded')
  unguarded(): { data: string } {
    return { data: 'should never be reachable' };
  }

  /** TC-13 over HTTP: a scoped query from a route with no actor and therefore no scope. */
  @Get('unscoped')
  @Public()
  async unscoped(): Promise<unknown> {
    return this.fixture.scoped.findAll(TenantCampaign);
  }

  /** Confirms the request's scope is the token's, for the concurrency test. */
  @Get('whoami')
  @Roles('super_admin', 'country_admin', 'tenant_admin', 'maker', 'checker', 'merchant')
  @RequirePermission('campaign', 'view')
  async whoami(): Promise<{ data: { tenantIds: number[] } }> {
    const rows = await this.fixture.scoped.findAll(TenantCampaign);
    return { data: { tenantIds: [...new Set(rows.map((row) => row.tenantId))] } };
  }
}

@Module({ imports: [RbacModule], controllers: [FixtureController], providers: [FixtureService] })
class FixtureModule {}

// --- harness --------------------------------------------------------------------------------

const PASSWORD = 'correct horse battery staple 7!';
/** `countries.code` is `character(2)` — hence a two-letter fixture code, not `T013`. */
const COUNTRY_CODE = 'ZZ';
const TENANT_A = 'T013_E2E_A';
const TENANT_B = 'T013_E2E_B';
const TENANT_C = 'T013_E2E_C';
const MERCHANT_1 = 'T013_E2E_M1';
const MERCHANT_2 = 'T013_E2E_M2';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let countryX: number;
let countryY: number;
let tenantA: number;
let tenantB: number;
let tenantC: number;
let merchant1: number;
let merchant2: number;
let campaignA1: number;
let campaignA2: number;
let campaignB1: number;
let campaignC1: number;

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

/** Creates (or reuses) a portal user and logs it in, caching the cookie jar. */
async function makeActor(
  key: string,
  role: PortalRole,
  scope: { countryId: number | null; tenantId: number | null; merchantId: number | null },
): Promise<Actor> {
  const email = `t013-e2e-${key}@example.invalid`;

  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const created = {
    id: await insertPortalUser(db, emailCrypto, {
      email,
      displayName: `T-013 ${key}`,
      role,
      ...scope,
    }),
  };

  await exec(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { userId: created.id, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
  );

  // T-055 made a second factor structurally mandatory for `super_admin`, so a login by that role
  // now ends in an MFA challenge rather than in a session (02-SECURITY.md §2a).
  // `loginCompletingMfa` completes it through the real endpoints — nothing stubbed, no guard
  // bypassed — and is a plain login for the other five roles, which are unaffected.
  const response = await loginCompletingMfa(app, { email, password: PASSWORD }, db);
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

function patch(key: string, path: string, body: unknown) {
  return http()
    .patch(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send(body as object);
}

/** Idempotent lookup-or-insert, because `reward_app` cannot DELETE from `reward_config`. */
async function ensureCountry(code: string, name: string): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.countries WHERE code = :code`,
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
     VALUES (:code, :name, 'UTC', 'USD', '+000', 'active')
     RETURNING id`,
    { code, name },
  );
  return created.id;
}

async function ensureTenant(code: string, countryId: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.tenants WHERE code = :code`,
    { code },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.tenants
          SET status = 'active', deleted_at = NULL, country_id = :countryId
        WHERE id = :id`,
      { id: existing.id, countryId },
    );
    return existing.id;
  }

  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active')
     RETURNING id`,
    { code, countryId },
  );
  return created.id;
}

async function ensureMerchant(code: string, tenantId: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.merchants WHERE merchant_code = :code`,
    { code },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.merchants
          SET status = 'active', deleted_at = NULL, tenant_id = :tenantId
        WHERE id = :id`,
      { id: existing.id, tenantId },
    );
    return existing.id;
  }

  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.merchants (tenant_id, merchant_code, name, country_code, status)
     VALUES (:tenantId, :code, :code, :countryCode, 'active')
     RETURNING id`,
    { code, tenantId, countryCode: COUNTRY_CODE },
  );
  return created.id;
}

async function ensureCampaign(code: string, tenantId: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.tenant_campaigns WHERE campaign_code = :code`,
    { code },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.tenant_campaigns
          SET deleted_at = NULL, tenant_id = :tenantId, name = :code, status = 'draft'
        WHERE id = :id`,
      { id: existing.id, tenantId, code },
    );
    return existing.id;
  }

  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenant_campaigns
            (tenant_id, campaign_code, name, start_date, end_date, status, created_by)
     VALUES (:tenantId, :code, :code, now(), now() + interval '30 days', 'draft', 't013-e2e')
     RETURNING id`,
    { code, tenantId },
  );
  return created.id;
}

async function ensureParticipation(
  tenantId: number,
  campaignId: number,
  merchantId: number,
): Promise<void> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.campaign_merchants
      WHERE campaign_id = :campaignId AND merchant_id = :merchantId`,
    { campaignId, merchantId },
  );
  if (existing !== undefined) {
    await exec(`UPDATE reward_config.campaign_merchants SET status = 'active' WHERE id = :id`, {
      id: existing.id,
    });
    return;
  }

  await exec(
    `INSERT INTO reward_config.campaign_merchants (tenant_id, campaign_id, merchant_id, status)
     VALUES (:tenantId, :campaignId, :merchantId, 'active')`,
    { tenantId, campaignId, merchantId },
  );
}

/**
 * The tenant ids each TC-22 actor is *authorised* to see, read straight from the database.
 *
 * **Why this is a query and not a literal (T-150).** `countryX` is not a fixture this suite
 * creates: `beforeAll` takes `SELECT id FROM countries ORDER BY id LIMIT 1`, which on any real
 * database is the seeded home country (locally, `1` — `MY`). `tenantA`/`tenantB` are then created
 * *inside* it. So a `country_admin` of X is legitimately scoped to every other tenant in that
 * country too — including the seeded `DEMO` tenant — and TC-22's original `expected:
 * [tenantA, tenantB]` was a closed-world assumption that only held while nothing else in the home
 * country had a live campaign. It stopped holding the moment an unrelated campaign was created
 * under `DEMO` through the portal's own Maker screen, and TC-22 then reported that correctly
 * scoped row as a cross-tenant leak. Every other country-scoped test here (TC-8, and the
 * subquery test beside it) already asserts against the database for exactly this reason; TC-22
 * was the one that did not.
 *
 * The `countryX` query is the same boundary `scope-strategy.ts`'s `TENANTS_IN_COUNTRY` builds —
 * written out again here in plain SQL, deliberately, so the expectation is derived independently
 * of the code under test rather than from it. The other three actors are single-tenant by
 * construction (`maker`/`merchant` scope is `tenant_id = :tenantId`, straight off the verified
 * JWT), so their boundary really is one literal id and stays one.
 */
async function authorisedTenantIds(): Promise<{
  makerA: number[];
  makerB: number[];
  merchant1: number[];
  countryX: number[];
}> {
  const rows = await sql<{ id: number }>(
    `SELECT id FROM reward_config.tenants WHERE country_id = :countryId ORDER BY id`,
    { countryId: countryX },
  );

  return {
    makerA: [tenantA],
    makerB: [tenantB],
    merchant1: [tenantA],
    countryX: rows.map((row) => row.id),
  };
}

/** The tenant ids in `seen` that `authorised` does not permit — empty means zero leakage. */
function crossTenantLeaks(authorised: readonly number[], seen: readonly number[]): number[] {
  return seen.filter((tenantId) => !authorised.includes(tenantId));
}

/**
 * `rbac_version:maker`, read/bumped/**restored to its exact prior value**.
 *
 * The restore is not cosmetic. `rbac_cache_config` is seeded global state that T-004's own e2e
 * asserts on (`rbac_version:<role>` = `1` for all six roles), so a suite that bumped the counter
 * and left it raised would break an unrelated, already-`done` task's test a little more on every
 * run — which is exactly what an earlier draft of this file did, reaching 49 before it was
 * noticed.
 *
 * Restoring works for the cache-invalidation the tests need because `PermissionCacheService`
 * keys its entry on `role + version` and treats **any** difference as a miss. Going 1 → 2 → 1
 * invalidates twice, which is what both tests want, and leaves the row as the seed wrote it.
 */
async function readMakerRbacVersion(): Promise<string> {
  const [row] = await sql<{ config_value: string }>(
    `SELECT config_value FROM reward_config.rbac_cache_config
      WHERE config_key = 'rbac_version:maker'`,
  );
  return row.config_value;
}

async function bumpMakerRbacVersion(): Promise<void> {
  await exec(
    `UPDATE reward_config.rbac_cache_config
        SET config_value = (config_value::bigint + 1)::text, updated_at = now()
      WHERE config_key = 'rbac_version:maker'`,
  );
}

async function restoreMakerRbacVersion(value: string): Promise<void> {
  await exec(
    `UPDATE reward_config.rbac_cache_config
        SET config_value = :value, updated_at = now()
      WHERE config_key = 'rbac_version:maker'`,
    { value },
  );
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, FixtureModule],
  }).compile();

  // T-055: `super_admin` enrolment writes an encrypted `mfa_secret_enc`, which needs an active
  // `field` key. T-056 added a `blind_index` key to the same list — `portal_users.email` is
  // encrypted, so every login computes an HMAC to find the account. Inserted **before** the
  // application starts, because `KeyRegistryService` reads `encryption_keys` once, at boot.
  // Removed again in `afterAll`.
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), MFA_SUITE);

  app = moduleRef.createNestApplication();
  // Identical to main.ts — the pipe is part of the contract under test (TC-14's first half).
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // `listen`, not just `init`. Supertest binds the server itself on the first `request(server)`
  // call when it is not already listening — and with many of those calls in flight at once (TC-22)
  // the racing `listen(0)`s produce `ECONNRESET` before a single request reaches a guard. Binding
  // once here removes that entirely, and is closer to how the server actually runs.
  await app.listen(0);

  db = app.get<Sequelize>(SEQUELIZE);
  emailCrypto = emailCryptoOf(app);

  const [home] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.countries ORDER BY id LIMIT 1`,
  );
  countryX = home.id;
  countryY = await ensureCountry(COUNTRY_CODE, 'T-013 e2e country');

  tenantA = await ensureTenant(TENANT_A, countryX);
  tenantB = await ensureTenant(TENANT_B, countryX);
  tenantC = await ensureTenant(TENANT_C, countryY);

  merchant1 = await ensureMerchant(MERCHANT_1, tenantA);
  merchant2 = await ensureMerchant(MERCHANT_2, tenantA);

  campaignA1 = await ensureCampaign('T013_E2E_A1', tenantA);
  campaignA2 = await ensureCampaign('T013_E2E_A2', tenantA);
  campaignB1 = await ensureCampaign('T013_E2E_B1', tenantB);
  campaignC1 = await ensureCampaign('T013_E2E_C1', tenantC);

  // merchant1 participates in A1 only; merchant2 in A2. A1 is the campaign merchant1 may see.
  await ensureParticipation(tenantA, campaignA1, merchant1);
  await ensureParticipation(tenantA, campaignA2, merchant2);

  await makeActor('super', 'super_admin', { countryId: null, tenantId: null, merchantId: null });
  await makeActor('countryX', 'country_admin', {
    countryId: countryX,
    tenantId: null,
    merchantId: null,
  });
  await makeActor('makerA', 'maker', { countryId: countryX, tenantId: tenantA, merchantId: null });
  await makeActor('makerB', 'maker', { countryId: countryX, tenantId: tenantB, merchantId: null });
  await makeActor('merchant1', 'merchant', {
    countryId: countryX,
    tenantId: tenantA,
    merchantId: merchant1,
  });
  await makeActor('suspendable', 'maker', {
    countryId: countryX,
    tenantId: tenantB,
    merchantId: null,
  });
  await makeActor('merchantSuspendable', 'merchant', {
    countryId: countryX,
    tenantId: tenantA,
    merchantId: merchant2,
  });
});

afterAll(async () => {
  if (db !== undefined) {
    // T-056: `email` is ciphertext, so a `LIKE` over it matches nothing. `display_name` is not
    // encrypted and every actor sets it to `T-013 <key>`, which makes it the reliable handle.
    await exec(`DELETE FROM reward_portal.portal_users WHERE display_name LIKE 'T-013 %'`);

    // `reward_app` has DELETE on nothing in reward_config (01-DATABASE.md §3): campaigns are
    // soft-deleted, everything else is retired in place. See the file header.
    await exec(
      `UPDATE reward_config.tenant_campaigns SET deleted_at = now()
        WHERE campaign_code LIKE 'T013_E2E%'`,
    );
    await exec(
      `UPDATE reward_config.campaign_merchants SET status = 'inactive'
        WHERE campaign_id IN (SELECT id FROM reward_config.tenant_campaigns
                               WHERE campaign_code LIKE 'T013_E2E%')`,
    );
    await exec(
      `UPDATE reward_config.merchants SET status = 'inactive' WHERE merchant_code LIKE 'T013_E2E%'`,
    );
    await exec(
      `UPDATE reward_config.tenants SET status = 'inactive', deleted_at = now()
        WHERE code LIKE 'T013_E2E%'`,
    );
    await exec(`UPDATE reward_config.countries SET status = 'inactive' WHERE code = :code`, {
      code: COUNTRY_CODE,
    });

    // T-055's and T-056's fixture keys, removed so the real key configuration is unchanged.
    await removeEncryptionKeys(db, MFA_SUITE);
  }
  if (app !== undefined) await app.close();
});

// --- the tests ----------------------------------------------------------------------------------

describe('TC-1/TC-2/TC-3 — the role layer over HTTP', () => {
  it('TC-2: a maker is refused a super_admin-only service assertion with PERM_DENIED', async () => {
    const response = await post('makerA', '/t013/rules', {});

    expect(response.status).toBe(403);
    // T-014: the envelope gained `message` and `traceId` (03-API-CONTRACT.md §1). The helper
    // still asserts there is nothing *else* in it, which is what this test is for.
    expectErrorEnvelope(response.body, 'PERM_DENIED');
  });

  it('TC-3: the 403 body names no resource, no id and no reason', async () => {
    const response = await post('makerA', '/t013/rules', {});
    const body = JSON.stringify(response.body);

    for (const leak of ['rule', 'super_admin', 'maker', 'assert', 'Fixture']) {
      expect(body).not.toContain(leak);
    }
  });

  it('TC-18: a route with no @Roles and no @Public is denied, not served', async () => {
    const response = await get('super', '/t013/unguarded');

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'PERM_DENIED');
  });

  it('GET /health survives the global chain (it is @Public)', async () => {
    const response = await http().get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('an unauthenticated request to a guarded route is 401, not 403', async () => {
    const response = await http().get('/api/v1/t013/campaigns');
    expect(response.status).toBe(401);
  });
});

describe('TC-4 — the permission layer over HTTP', () => {
  it('admits a maker holding campaign:create', async () => {
    const response = await post('makerA', '/t013/campaigns', { name: 'T-013 permitted' });
    expect(response.status).toBe(201);
  });

  it('refuses a merchant, whose seeded campaign grant is view-only', async () => {
    // `role_entity_permissions` seeds `merchant → campaign → ["view"]` (01-DATABASE.md §5.1).
    // The role gate on POST /t013/campaigns is `maker`, so this is refused at layer 1 — asserted
    // to confirm the seeded matrix is what the guard actually reads.
    const response = await post('merchant1', '/t013/campaigns', { name: 'nope' });
    expect(response.status).toBe(403);
  });
});

describe('TC-5, TC-6, TC-7 — cross-tenant reads and writes', () => {
  it('TC-6: a maker lists only its own tenant’s campaigns, and the count matches direct SQL', async () => {
    const response = await get('makerA', '/t013/campaigns');
    expect(response.status).toBe(200);

    const returned: { id: number; tenantId: number }[] = response.body.data;
    expect(returned.every((row) => row.tenantId === tenantA)).toBe(true);
    expect(returned.map((row) => row.id)).toEqual(expect.arrayContaining([campaignA1, campaignA2]));
    expect(returned.map((row) => row.id)).not.toContain(campaignB1);

    const [direct] = await sql<{ count: string }>(
      `SELECT count(*) AS count FROM reward_config.tenant_campaigns
        WHERE tenant_id = :tenantId AND deleted_at IS NULL`,
      { tenantId: tenantA },
    );
    // The count is computed in the database inside the scope, not by counting a filtered array.
    expect(response.body.total).toBe(Number(direct.count));
    expect(returned).toHaveLength(Number(direct.count));
  });

  it('TC-5: tenant A’s maker requesting tenant B’s campaign by id gets 404, not 403, not 200', async () => {
    const response = await get('makerA', `/t013/campaigns/${campaignB1}`);

    expect(response.status).toBe(404);
    expectErrorEnvelope(response.body, 'NOT_FOUND');
  });

  it('verification step 4: no row appears in the response at any nesting level', async () => {
    const response = await get('makerA', `/t013/campaigns/${campaignB1}`);
    const body = JSON.stringify(response.body);

    expect(body).not.toContain(String(campaignB1));
    expect(body).not.toContain(String(tenantB));
    expect(body).not.toContain('T013_E2E_B1');
  });

  it('the same id is 200 for the tenant that owns it — so the 404 is scope, not a broken route', async () => {
    const response = await get('makerB', `/t013/campaigns/${campaignB1}`);

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(campaignB1);
  });

  it('a missing id and an out-of-scope id are byte-identical responses', async () => {
    const outOfScope = await get('makerA', `/t013/campaigns/${campaignB1}`);
    const nonexistent = await get('makerA', '/t013/campaigns/2147483600');

    expect(outOfScope.status).toBe(nonexistent.status);
    // T-014: every error body now carries a per-request `traceId`, which differs between *any*
    // two requests — including two identical ones — so it cannot distinguish these two. The rest
    // of the body must still be identical, which is the property 02-SECURITY.md §5.1 requires.
    expect(withoutTraceId(outOfScope.body)).toEqual(withoutTraceId(nonexistent.body));
  });

  it('TC-7 / verification step 5: a cross-tenant PATCH is 404 and leaves the row untouched', async () => {
    const [before] = await sql<{ name: string; updated_at: Date; tenant_id: number }>(
      `SELECT name, updated_at, tenant_id FROM reward_config.tenant_campaigns WHERE id = :id`,
      { id: campaignB1 },
    );

    const response = await patch('makerA', `/t013/campaigns/${campaignB1}`, {
      name: 'hijacked by tenant A',
    });

    expect(response.status).toBe(404);

    const [after] = await sql<{ name: string; updated_at: Date; tenant_id: number }>(
      `SELECT name, updated_at, tenant_id FROM reward_config.tenant_campaigns WHERE id = :id`,
      { id: campaignB1 },
    );

    expect(after.name).toBe(before.name);
    expect(after.tenant_id).toBe(before.tenant_id);
    // `updated_at` unchanged: the UPDATE matched zero rows, so Sequelize's timestamp never fired.
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
  });

  it('an in-scope PATCH does update the row, so the previous test is not passing vacuously', async () => {
    const response = await patch('makerA', `/t013/campaigns/${campaignA2}`, {
      name: 'renamed by its owner',
    });

    expect(response.status).toBe(200);

    const [row] = await sql<{ name: string }>(
      `SELECT name FROM reward_config.tenant_campaigns WHERE id = :id`,
      { id: campaignA2 },
    );
    expect(row.name).toBe('renamed by its owner');

    await exec(`UPDATE reward_config.tenant_campaigns SET name = :code WHERE id = :id`, {
      id: campaignA2,
      code: 'T013_E2E_A2',
    });
  });

  it('a PATCH cannot move a row into another tenant', async () => {
    const response = await patch('makerA', `/t013/campaigns/${campaignA1}`, {
      name: 'still mine',
      tenantId: tenantB,
    });

    expect(response.status).toBe(200);

    const [row] = await sql<{ tenant_id: number }>(
      `SELECT tenant_id FROM reward_config.tenant_campaigns WHERE id = :id`,
      { id: campaignA1 },
    );
    expect(row.tenant_id).toBe(tenantA);

    await exec(`UPDATE reward_config.tenant_campaigns SET name = :code WHERE id = :id`, {
      id: campaignA1,
      code: 'T013_E2E_A1',
    });
  });
});

describe('TC-8, TC-9 — country scope (the subquery path against real Postgres)', () => {
  it('TC-8: a country_admin of X lists only X’s tenants', async () => {
    const response = await get('countryX', '/t013/tenants');
    expect(response.status).toBe(200);

    const ids: number[] = response.body.data;
    expect(ids).toEqual(expect.arrayContaining([tenantA, tenantB]));
    expect(ids).not.toContain(tenantC);

    const [direct] = await sql<{ count: string }>(
      `SELECT count(*) AS count FROM reward_config.tenants
        WHERE country_id = :countryId AND deleted_at IS NULL`,
      { countryId: countryX },
    );
    expect(ids).toHaveLength(Number(direct.count));
  });

  it('TC-9: a country_admin of X reading a tenant in country Y gets 404', async () => {
    const response = await get('countryX', `/t013/tenants/${tenantC}`);

    expect(response.status).toBe(404);
    expectErrorEnvelope(response.body, 'NOT_FOUND');
  });

  it('the tenants-in-country subquery really runs in Postgres, with the value bound', async () => {
    // The whole point of this file: `tenant_id IN (SELECT id FROM tenants WHERE country_id = …)`
    // is a `literal()` fragment whose value arrives through `options.replacements`. If Sequelize
    // ever stopped substituting it, this request would fail with "Named replacement :rsScope0 has
    // no entry" rather than quietly running unscoped — and either way this assertion would fail.
    const response = await get('countryX', '/t013/campaigns');

    expect(response.status).toBe(200);
    const tenantIds: number[] = response.body.data.map((row: { tenantId: number }) => row.tenantId);
    expect(tenantIds).toEqual(expect.arrayContaining([tenantA, tenantB]));
    expect(tenantIds).not.toContain(tenantC);
  });

  it('a country_admin of X cannot read a campaign belonging to country Y', async () => {
    const response = await get('countryX', `/t013/campaigns/${campaignC1}`);
    expect(response.status).toBe(404);
  });
});

describe('TC-10, TC-11 — merchant scope', () => {
  it('TC-10: a merchant lists only campaigns it participates in', async () => {
    const response = await get('merchant1', '/t013/campaigns');

    expect(response.status).toBe(200);
    expect(response.body.data.map((row: { id: number }) => row.id)).toEqual([campaignA1]);
  });

  it('TC-11: a merchant reading a campaign it does not participate in gets 404', async () => {
    // Same tenant, so only the participation subquery stands between the two.
    const response = await get('merchant1', `/t013/campaigns/${campaignA2}`);

    expect(response.status).toBe(404);
    expectErrorEnvelope(response.body, 'NOT_FOUND');
  });

  it('a merchant reading its own campaign gets 200', async () => {
    const response = await get('merchant1', `/t013/campaigns/${campaignA1}`);

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(campaignA1);
  });

  it('an inactive participation row stops counting immediately', async () => {
    await exec(
      `UPDATE reward_config.campaign_merchants SET status = 'inactive'
        WHERE campaign_id = :campaignId AND merchant_id = :merchantId`,
      { campaignId: campaignA1, merchantId: merchant1 },
    );

    const response = await get('merchant1', `/t013/campaigns/${campaignA1}`);
    expect(response.status).toBe(404);

    await ensureParticipation(tenantA, campaignA1, merchant1);
  });
});

describe('TC-12 — super_admin', () => {
  it('lists every tenant’s campaigns', async () => {
    const response = await get('super', '/t013/campaigns');

    expect(response.status).toBe(200);
    const ids: number[] = response.body.data.map((row: { id: number }) => row.id);
    expect(ids).toEqual(expect.arrayContaining([campaignA1, campaignA2, campaignB1, campaignC1]));
  });

  it('reads a campaign in any country', async () => {
    await expect(get('super', `/t013/campaigns/${campaignC1}`)).resolves.toMatchObject({
      status: 200,
    });
  });

  it('lists tenants across countries', async () => {
    const response = await get('super', '/t013/tenants');
    expect(response.body.data).toEqual(expect.arrayContaining([tenantA, tenantB, tenantC]));
  });
});

describe('TC-13 — a scoped query with no scope context', () => {
  it('fails loudly rather than returning every tenant’s rows', async () => {
    const response = await http().get('/api/v1/t013/unscoped');

    expect(response.status).toBe(500);
    // Whatever the body is, it must not be a list of campaigns.
    expect(JSON.stringify(response.body)).not.toContain('T013_E2E');
  });
});

describe('TC-14 — a client-supplied tenantId', () => {
  it('is rejected by forbidNonWhitelisted when the DTO does not declare it', async () => {
    const response = await post('makerA', '/t013/campaigns/strict', {
      name: 'x',
      tenantId: tenantB,
    });

    expect(response.status).toBe(400);
  });

  it('is overwritten with the actor’s scope when it does reach the service', async () => {
    const response = await post('makerA', '/t013/campaigns', {
      name: 'T-013 mass assignment attempt',
      tenantId: tenantB,
    });

    expect(response.status).toBe(201);

    const [row] = await sql<{ tenant_id: number }>(
      `SELECT tenant_id FROM reward_config.tenant_campaigns WHERE id = :id`,
      { id: response.body.data.id },
    );
    // The row is tenant A's, whatever the body said.
    expect(row.tenant_id).toBe(tenantA);
  });

  it('and the created row is invisible to the tenant that was named', async () => {
    const created = await post('makerA', '/t013/campaigns', {
      name: 'T-013 mass assignment attempt 2',
      tenantId: tenantB,
    });

    const response = await get('makerB', `/t013/campaigns/${created.body.data.id}`);
    expect(response.status).toBe(404);
  });
});

describe('TC-15 — a hand-edited JWT', () => {
  it('is rejected with 401 because the signature no longer verifies', async () => {
    const actor = as('makerA');
    const accessCookie = actor.jar
      .split('; ')
      .find((pair) => pair.startsWith('__Host-rs_at=')) as string;

    const [name, token] = [accessCookie.slice(0, 13), accessCookie.slice(14)];
    const [header, payload, signature] = token.split('.');

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    claims.tenantId = 999;
    const forged = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');

    const tampered = actor.jar.replace(accessCookie, `${name}=${header}.${forged}.${signature}`);

    const response = await http().get('/api/v1/t013/campaigns').set('Cookie', tampered);

    expect(response.status).toBe(401);
  });
});

describe('TC-16 — a permission revoked and the version bumped', () => {
  it('denies within the cache TTL', async () => {
    // Warm the cache.
    await expect(get('makerA', '/t013/campaigns')).resolves.toMatchObject({ status: 200 });

    const [before] = await sql<{ actions: string }>(
      `SELECT actions FROM reward_config.role_entity_permissions
        WHERE role = 'maker' AND entity = 'campaign'`,
    );
    const versionBefore = await readMakerRbacVersion();

    try {
      await exec(
        `UPDATE reward_config.role_entity_permissions
            SET actions = '["create"]', updated_at = now()
          WHERE role = 'maker' AND entity = 'campaign'`,
      );
      await bumpMakerRbacVersion();

      const response = await get('makerA', '/t013/campaigns');
      expect(response.status).toBe(403);
      expectErrorEnvelope(response.body, 'PERM_DENIED');
    } finally {
      await exec(
        `UPDATE reward_config.role_entity_permissions
            SET actions = :actions, updated_at = now()
          WHERE role = 'maker' AND entity = 'campaign'`,
        { actions: before.actions },
      );
      await restoreMakerRbacVersion(versionBefore);
    }

    // Restored, and effective immediately.
    await expect(get('makerA', '/t013/campaigns')).resolves.toMatchObject({ status: 200 });
  });
});

/**
 * TC-19 — *"`maker` granted `rule:create` by editing the DB, then calls `POST /rules` → 403 —
 * service-layer assertion overrides the table."*
 *
 * The route used here, `POST /t013/rules-as-campaign-create`, carries
 * `@Roles('super_admin', 'maker')` and `@RequirePermission('campaign', 'create')` — an action the
 * seeded matrix genuinely grants `maker` (01-DATABASE.md §5.1). So both guard layers admit the
 * request on the strength of the **real, unmodified** permission table, and the 403 can only come
 * from `assertRole(actor, 'super_admin')` inside the service.
 *
 * That is the same proposition as the task's wording — "the table permits it, the service refuses
 * it" — reached without editing `role_entity_permissions`. Two reasons to prefer it:
 *
 *  - it is a **stronger** test. A hand-edited row proves the assertion beats a row somebody
 *    tampered with; a genuine grant proves it beats the shipped configuration.
 *  - the edit was a real problem. `role_entity_permissions` is global seed data that T-004's own
 *    e2e rewrites and row-counts, and the two suites run in parallel Jest workers against one
 *    database — so the mutation here intermittently failed *T-004's* tests. See the T-013
 *    completion report; the residual instance of this in TC-16 below is flagged there too.
 */
describe('TC-19 — the service-layer assertion overrides the permission table', () => {
  it('refuses a maker whom both guard layers have just admitted', async () => {
    // Layer 1 (`@Roles`) admits `maker`; layer 2 admits `campaign:create`, which the seeded
    // matrix really does grant. Proven by the fact that the *same* actor gets 201 on the plain
    // campaign-create route immediately below.
    await expect(
      post('makerA', '/t013/campaigns', { name: 'T-013 layer-2 control' }),
    ).resolves.toMatchObject({ status: 201 });

    const response = await post('makerA', '/t013/rules-as-campaign-create', {});

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, 'PERM_DENIED');
  });

  it('admits a super_admin through the same service call', async () => {
    // Via `/t013/rules`, not the route above: the seeded matrix grants `super_admin` →
    // `rule:create` but only `campaign:view`, so layer 2 legitimately stops a Super Admin on a
    // route gated by `campaign:create`. Same `FixtureService.createRule`, same `assertRole`.
    const response = await post('super', '/t013/rules', {});
    expect(response.status).toBe(201);
  });

  it('also refuses a maker on a route gated by rule:create, which it does not hold', async () => {
    // The layer-2 half, for completeness: with no service assertion involved at all, the seeded
    // matrix alone already denies `maker` → `rule:create`.
    const response = await post('makerA', '/t013/rules', {});
    expect(response.status).toBe(403);
  });
});

describe('TC-21, TC-22 — concurrency through the whole chain', () => {
  it('TC-21: two tenants’ requests in flight together each see only their own scope', async () => {
    const [a, b] = await Promise.all([
      get('makerA', '/t013/whoami'),
      get('makerB', '/t013/whoami'),
    ]);

    expect(a.body.data.tenantIds).toEqual([tenantA]);
    expect(b.body.data.tenantIds).toEqual([tenantB]);
  });

  it('TC-22: 500 interleaved mixed-tenant requests leak zero rows', async () => {
    // Split across four actors so the per-user rate limit (300/min) is not the thing under test.
    // `expected` is each actor's real authorisation boundary, read from the database by direct
    // SQL — see `authorisedTenantIds` for why `countryX`'s is not the literal pair
    // `[tenantA, tenantB]` it used to be (T-150).
    const authorised = await authorisedTenantIds();
    const plan = [
      { key: 'makerA', expected: authorised.makerA },
      { key: 'makerB', expected: authorised.makerB },
      { key: 'merchant1', expected: authorised.merchant1 },
      { key: 'countryX', expected: authorised.countryX },
    ];

    // 500 requests, up to `CONCURRENCY` of them genuinely in flight at once.
    //
    // Firing all 500 simultaneously exhausts the loopback socket pool and produces `ECONNRESET`
    // before any of them reaches a guard — which fails the test for a reason that has nothing to
    // do with tenancy, and (worse) leaves the server recovering into the *next* test. A bounded
    // pool keeps the property under test intact: requests from four different tenants are
    // interleaved on one process throughout, which is precisely the condition an AsyncLocalStorage
    // leak needs. 40-way concurrency over 500 requests means every request in the run shares the
    // event loop with 39 others belonging to other tenants.
    const CONCURRENCY = 40;
    const results: { entry: (typeof plan)[number]; response: request.Response }[] = [];

    for (let start = 0; start < 500; start += CONCURRENCY) {
      const batch = Array.from(
        { length: Math.min(CONCURRENCY, 500 - start) },
        (_, offset) => plan[(start + offset) % plan.length],
      ).map((entry) => get(entry.key, '/t013/whoami').then((response) => ({ entry, response })));

      results.push(...(await Promise.all(batch)));
    }

    // Zero cross-tenant rows: every tenant id in every response is one that actor may see.
    // Collected rather than asserted per-id so a failure names the actor and *all* the ids it
    // should not have seen, instead of stopping at the first — that difference is what made the
    // original defect report ambiguous between "a leak" and "a stale fixture assumption".
    const leaks: { key: string; leaked: number[] }[] = [];
    for (const { entry, response } of results) {
      expect(response.status).toBe(200);
      const seen: number[] = response.body.data.tenantIds;

      const leaked = crossTenantLeaks(entry.expected, seen);
      if (leaked.length > 0) leaks.push({ key: entry.key, leaked });

      // A tenant in the *other* country, which no actor in the plan is scoped to, must never
      // appear for anyone. This one is a fixed fact about the fixtures, not a database lookup,
      // so it holds even if `authorisedTenantIds` were itself wrong.
      expect(seen).not.toContain(tenantC);
    }
    expect(leaks).toEqual([]);

    // Non-vacuity, per actor: each one really did see the rows it is entitled to, so the loop
    // above is not passing over 500 empty responses.
    const seenBy = (key: string) =>
      new Set(
        results
          .filter(({ entry }) => entry.key === key)
          .flatMap(({ response }) => response.body.data.tenantIds as number[]),
      );

    expect([...seenBy('makerA')]).toEqual([tenantA]);
    expect([...seenBy('makerB')]).toEqual([tenantB]);
    // And the merchant really did see something, so the assertion above is not vacuous.
    const merchantResults = results.filter(({ entry }) => entry.key === 'merchant1');
    expect(merchantResults.every(({ response }) => response.body.data.tenantIds.length === 1)).toBe(
      true,
    );
    expect([...seenBy('merchant1')]).toEqual([tenantA]);
    expect([...seenBy('countryX')]).toEqual(expect.arrayContaining([tenantA, tenantB]));
  });

  /**
   * T-150 TC-3 — proof that the check above has teeth.
   *
   * The 500-request loop can only fail if `crossTenantLeaks` reports something, and widening
   * `countryX`'s expected set (see `authorisedTenantIds`) is exactly the kind of change that can
   * quietly turn a security assertion into a tautology. These three cases run the same function
   * over forged data, where a leak is known to be present, and are the reason a green TC-22 means
   * something: they fail if the comparison is ever loosened to `[]`, to a superset, or to nothing.
   */
  it('TC-22’s leak check rejects a forged cross-tenant response', async () => {
    expect(crossTenantLeaks([tenantA], [tenantA, tenantB])).toEqual([tenantB]);
    expect(crossTenantLeaks([tenantA, tenantB], [tenantC])).toEqual([tenantC]);
    expect(crossTenantLeaks([tenantA], [tenantA])).toEqual([]);

    // And the widened `countryX` set is still a real boundary: it admits the country's own
    // tenants and nothing from country Y, so a country_admin seeing `tenantC` still fails.
    const authorised = await authorisedTenantIds();
    expect(authorised.countryX).toEqual(expect.arrayContaining([tenantA, tenantB]));
    expect(authorised.countryX).not.toContain(tenantC);
    expect(crossTenantLeaks(authorised.countryX, [tenantC])).toEqual([tenantC]);
  });
});

describe('TC-23, TC-24 — a suspended parent revokes a live session (AR-10)', () => {
  it('TC-23: a maker’s session is refused on its next request once its tenant is suspended', async () => {
    // Live and working first, so the denial below is caused by the suspension and nothing else.
    await expect(get('suspendable', '/t013/campaigns')).resolves.toMatchObject({ status: 200 });

    const [sessionBefore] = await sql<{ count: string }>(
      `SELECT count(*) AS count FROM reward_portal.portal_sessions
        WHERE user_id = :userId AND status = 'active'`,
      { userId: as('suspendable').userId },
    );
    expect(Number(sessionBefore.count)).toBe(1);

    try {
      await exec(`UPDATE reward_config.tenants SET status = 'suspended' WHERE id = :id`, {
        id: tenantB,
      });

      const response = await get('suspendable', '/t013/campaigns');
      expect(response.status).toBe(401);

      // The crucial half: **no bulk revoke has run.** The session row is still `active`, and the
      // denial comes entirely from the parent-status join AR-10 added.
      const [sessionAfter] = await sql<{ count: string }>(
        `SELECT count(*) AS count FROM reward_portal.portal_sessions
          WHERE user_id = :userId AND status = 'active'`,
        { userId: as('suspendable').userId },
      );
      expect(Number(sessionAfter.count)).toBe(1);
    } finally {
      await exec(`UPDATE reward_config.tenants SET status = 'active' WHERE id = :id`, {
        id: tenantB,
      });
    }

    // Reinstating the tenant restores the session — it was never revoked.
    await expect(get('suspendable', '/t013/campaigns')).resolves.toMatchObject({ status: 200 });
  });

  it('TC-24: a merchant user’s session is refused once its merchant is deactivated', async () => {
    await expect(get('merchantSuspendable', '/t013/campaigns')).resolves.toMatchObject({
      status: 200,
    });

    try {
      await exec(`UPDATE reward_config.merchants SET status = 'inactive' WHERE id = :id`, {
        id: merchant2,
      });

      const response = await get('merchantSuspendable', '/t013/campaigns');
      expect(response.status).toBe(401);
    } finally {
      await exec(`UPDATE reward_config.merchants SET status = 'active' WHERE id = :id`, {
        id: merchant2,
      });
    }

    await expect(get('merchantSuspendable', '/t013/campaigns')).resolves.toMatchObject({
      status: 200,
    });
  });

  it('a suspended tenant does not affect a user in a different tenant', async () => {
    try {
      await exec(`UPDATE reward_config.tenants SET status = 'suspended' WHERE id = :id`, {
        id: tenantB,
      });

      await expect(get('makerA', '/t013/campaigns')).resolves.toMatchObject({ status: 200 });
    } finally {
      await exec(`UPDATE reward_config.tenants SET status = 'active' WHERE id = :id`, {
        id: tenantB,
      });
    }
  });

  it('a super_admin, who has no tenant, is unaffected by any suspension', async () => {
    try {
      await exec(`UPDATE reward_config.tenants SET status = 'suspended' WHERE id = :id`, {
        id: tenantA,
      });

      await expect(get('super', '/t013/campaigns')).resolves.toMatchObject({ status: 200 });
    } finally {
      await exec(`UPDATE reward_config.tenants SET status = 'active' WHERE id = :id`, {
        id: tenantA,
      });
    }
  });
});
