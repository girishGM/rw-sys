/**
 * T-092 — `GET /dashboard/widgets/:widgetKey` against the **real** Postgres instance, through
 * the real `AppModule`, over real HTTP, as every role. Follows the harness
 * `test/rules/rules.e2e-spec.ts` (T-031) and `test/merchant-portal/merchant-portal.e2e-spec.ts`
 * (T-039) both establish: real login (through MFA for `super_admin`, T-055), real cookies, real
 * guards, real `ScopedRepository` scoping.
 *
 * ### Why this defect specifically needs an e2e proof, not just unit coverage
 *
 * The bug this task fixes — `dashboard.service.ts`'s own header has the full history — was never
 * a logic bug `DashboardService`'s unit suite could have caught: the route simply did not exist.
 * `dashboard.service.spec.ts` proves every resolver's query shape against a fake repository, but
 * a fake repository cannot prove a controller is wired into `AppModule` and reachable over real
 * HTTP with the real guard chain in front of it. Only this file can, and it is the file that
 * would have failed red before this task's fix (verified manually — see the completion report:
 * commenting `DashboardModule` out of `app.module.ts`'s `imports` array turns TC-1 below into a
 * `404` with `route not found`, from Nest itself, before `DashboardController` is ever reached).
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
import type { PortalRole } from '@/database/portal-models';
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

const SUITE = 't092';
const PASSWORD = 'correct horse battery staple 7!';
const COUNTRY_A_CODE = 'W1';
const COUNTRY_B_CODE = 'W2';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let countryA: number;
let countryB: number;
let tenantA: number;
let merchantA: number;
let campaignId: number;

interface Actor {
  readonly key: string;
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

async function makeActor(
  key: string,
  role: PortalRole,
  scope: { countryId: number | null; tenantId: number | null; merchantId: number | null },
): Promise<Actor> {
  const email = `t092-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-092 ${key}`,
    role,
    ...scope,
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

  const actor: Actor = {
    key,
    email,
    userId,
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

// --- fixtures --------------------------------------------------------------------------------

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

async function ensureTenant(code: string, countryIdValue: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.tenants WHERE code = :code',
    { code },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.tenants SET status = 'active', country_id = :countryId WHERE id = :id`,
      { id: existing.id, countryId: countryIdValue },
    );
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active') RETURNING id`,
    { code, countryId: countryIdValue },
  );
  return created.id;
}

async function ensureMerchant(
  code: string,
  tenantIdValue: number,
  countryCode: string,
): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.merchants WHERE merchant_code = :code',
    { code },
  );
  if (existing !== undefined) return existing.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.merchants (tenant_id, merchant_code, name, country_code, status)
     VALUES (:tenantId, :code, :code, :countryCode, 'active') RETURNING id`,
    { tenantId: tenantIdValue, code, countryCode },
  );
  return created.id;
}

// --- lifecycle -------------------------------------------------------------------------------

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

  countryA = await ensureCountry(COUNTRY_A_CODE, 'T-092 e2e country A');
  countryB = await ensureCountry(COUNTRY_B_CODE, 'T-092 e2e country B');
  tenantA = await ensureTenant('T092E2E_TENANT_A', countryA);
  // Not read back — its existence is what the cross-country scoping test below asserts against,
  // via a real `count(*)` query, not this variable.
  await ensureTenant('T092E2E_TENANT_B', countryB);
  merchantA = await ensureMerchant('T092E2E_MERCHANT_A', tenantA, COUNTRY_A_CODE);

  await makeActor('super', 'super_admin', { countryId: null, tenantId: null, merchantId: null });
  await makeActor('adminA', 'country_admin', {
    countryId: countryA,
    tenantId: null,
    merchantId: null,
  });
  await makeActor('adminB', 'country_admin', {
    countryId: countryB,
    tenantId: null,
    merchantId: null,
  });
  await makeActor('tenantA', 'tenant_admin', {
    countryId: countryA,
    tenantId: tenantA,
    merchantId: null,
  });
  await makeActor('makerA', 'maker', { countryId: countryA, tenantId: tenantA, merchantId: null });
  await makeActor('checkerA', 'checker', {
    countryId: countryA,
    tenantId: tenantA,
    merchantId: null,
  });
  await makeActor('merchantA', 'merchant', {
    countryId: countryA,
    tenantId: tenantA,
    merchantId: merchantA,
  });

  // One draft campaign, authored by makerA, so `kpi_my_drafts`/`list_my_campaigns` (maker) and
  // `kpi_active_campaigns`/`chart_campaigns_by_country` (super_admin/country_admin) all have a
  // real row to count, and one participation row so `chart_campaign_performance` (merchant) has
  // a real, in-scope campaign to resolve against.
  const [campaign] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenant_campaigns
         (tenant_id, campaign_code, name, start_date, end_date, status, created_by)
     VALUES (:tenantId, :code, :name, now(), now() + interval '30 days', 'active', :createdBy)
     RETURNING id`,
    {
      tenantId: tenantA,
      code: 'T092E2E_CAMP',
      name: 'T-092 e2e campaign',
      createdBy: String(as('makerA').userId),
    },
  );
  campaignId = campaign.id;
  await exec(
    `INSERT INTO reward_config.campaign_merchants (tenant_id, campaign_id, merchant_id, status)
     VALUES (:tenantId, :campaignId, :merchantId, 'active')`,
    { tenantId: tenantA, campaignId, merchantId: merchantA },
  );
});

afterAll(async () => {
  if (db !== undefined) {
    await exec('DELETE FROM reward_config.campaign_merchants WHERE campaign_id = :id', {
      id: campaignId,
    });
    await exec('DELETE FROM reward_config.tenant_campaigns WHERE id = :id', { id: campaignId });
    for (const actor of actors.values()) {
      await exec('DELETE FROM reward_portal.portal_users WHERE id = :id', { id: actor.userId });
    }
    await removeEncryptionKeys(db, SUITE);
  }
  if (app !== undefined) await app.close();
});

// --- the regression itself ----------------------------------------------------------------------

describe('the route exists and serves real data (T-092 TC-1/TC-2)', () => {
  it('GET /dashboard/widgets/kpi_countries — super_admin gets a real envelope, not a route-missing 404', async () => {
    const response = await get('super', '/dashboard/widgets/kpi_countries');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { value: expect.any(Number) } });
    expect(response.body.data.value as number).toBeGreaterThanOrEqual(2); // at least A and B
  });

  it('GET /dashboard/widgets/kpi_active_campaigns — counts the real, active campaign this suite created', async () => {
    const response = await get('super', '/dashboard/widgets/kpi_active_campaigns');
    expect(response.status).toBe(200);
    expect(response.body.data.value as number).toBeGreaterThanOrEqual(1);
  });

  it('GET /dashboard/widgets/list_tenants_without_ceiling — the exact regression named in this task’s own evidence: reuses TenantsService for real', async () => {
    const response = await get('adminA', '/dashboard/widgets/list_tenants_without_ceiling');

    expect(response.status).toBe(200);
    const items = response.body.data.items as { id: number; primary: string }[];
    // tenantA has never had a tenant_budget_ceilings row inserted in this suite.
    expect(items.some((item) => item.id === tenantA)).toBe(true);
  });
});

describe('negative authorisation (R6)', () => {
  it('no session cookie at all → 401', async () => {
    const response = await http().get('/api/v1/dashboard/widgets/kpi_countries');
    expect(response.status).toBe(401);
  });

  it('a widget seeded for a different role → 404, indistinguishable from an unknown key (02-SECURITY.md §5.1)', async () => {
    // `kpi_countries` is seeded for `super_admin` only (01-DATABASE.md §5.3) — a merchant asking
    // for it must not learn it exists.
    const known = await get('merchantA', '/dashboard/widgets/kpi_countries');
    const unknown = await get('merchantA', '/dashboard/widgets/not_a_real_widget_key_at_all');

    expect(known.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(known.body.error.code).toBe(unknown.body.error.code);
  });
});

describe('cross-country scoping holds end to end (the same property T-013 proves structurally)', () => {
  it('country_admin B’s kpi_tenants matches country B’s real tenant count exactly — never country A’s', async () => {
    // Both countries are long-lived, code-keyed fixtures (`ensureCountry`/`ensureTenant` reuse
    // an existing row rather than insert a fresh one every run), so this asserts against the
    // real row count for each country rather than an assumed baseline — robust to whatever this
    // shared development database already holds.
    const [{ count: countryBTenantCount }] = await sql<{ count: string }>(
      'SELECT count(*)::int AS count FROM reward_config.tenants WHERE country_id = :countryId',
      { countryId: countryB },
    );
    const [{ count: countryATenantCount }] = await sql<{ count: string }>(
      'SELECT count(*)::int AS count FROM reward_config.tenants WHERE country_id = :countryId',
      { countryId: countryA },
    );

    const adminBResult = await get('adminB', '/dashboard/widgets/kpi_tenants');
    const adminAResult = await get('adminA', '/dashboard/widgets/kpi_tenants');

    expect(adminBResult.status).toBe(200);
    expect(adminAResult.status).toBe(200);
    // If tenantA (country A's own fixture) ever leaked into country B's scope, adminB's value
    // would exceed the real `reward_config.tenants` count for country B — it does not.
    expect(adminBResult.body.data.value).toBe(Number(countryBTenantCount));
    expect(adminAResult.body.data.value).toBe(Number(countryATenantCount));
    expect(adminAResult.body.data.value as number).toBeGreaterThanOrEqual(1);
  });
});

describe('maker and merchant widgets round-trip through the real database', () => {
  it('kpi_my_drafts is 0 for a maker with no draft campaigns of their own (the fixture campaign is active, not draft)', async () => {
    const response = await get('makerA', '/dashboard/widgets/kpi_my_drafts');
    expect(response.status).toBe(200);
    expect(response.body.data.value).toBe(0);
  });

  it('list_my_campaigns lists the real campaign this maker authored', async () => {
    const response = await get('makerA', '/dashboard/widgets/list_my_campaigns');
    expect(response.status).toBe(200);
    const items = response.body.data.items as { id: number; primary: string }[];
    expect(items.some((item) => item.id === campaignId)).toBe(true);
  });

  it('chart_campaign_performance — an honest empty series, HTTP 200, never an error tile', async () => {
    const response = await get('merchantA', '/dashboard/widgets/chart_campaign_performance');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { series: [] } });
  });
});
