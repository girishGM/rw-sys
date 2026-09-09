/**
 * T-INT-010 — the REST mirror of `CampaignConfigService` against the **real** Postgres instance,
 * through the real `AppModule`, over real HTTP (supertest). Nothing here is mocked: the same
 * `reward_config`/`reward_portal` rows `test/grpc/grpc.e2e-spec.ts` writes for the gRPC transport
 * are written here for this one (a trimmed subset — one rule version, one reward version, one
 * active campaign with a cap), and TC-1's parity assertion calls the real, DI-resolved
 * `CampaignConfigService` directly — the exact same call `campaign-config.controller.ts` makes on
 * the gRPC transport — so a REST/gRPC field mismatch is a real divergence, not a mocked one.
 *
 * ### Isolation
 *
 * Every fixture is prefixed `TINT010E2E` and removed in `afterAll`, following
 * `test/grpc/grpc.e2e-spec.ts`'s own pattern for the same tables. `grpc_service_grants` rows are
 * revoked rather than deleted (`T047_001` revokes `DELETE` from `reward_app` on purpose) and
 * reactivated via `ON CONFLICT` on a re-run, exactly as that suite documents.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type { ClientHttp2Session } from 'node:http2';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import { CampaignConfigService } from '@/grpc/campaign-config.service';
import { GRPC_METHOD, GRPC_SERVICE_FULL_NAME, type ConfigSectionName } from '@/grpc/grpc.constants';
import { GrpcStatus } from '@/grpc/grpc.errors';
import type { ResolvedServiceIdentity } from '@/grpc/service-scope.guard';
import { InternalServiceBootstrap } from '@/grpc/internal-service.bootstrap';
import type { InternalTlsListener } from '@/grpc/wire/grpc-http2.server';
import { decodeMessage, encodeMessage } from '@/grpc/wire/proto-codec';
import {
  CampaignConfigMessage,
  GetCampaignConfigRequestMessage,
} from '@/grpc/wire/campaign-config.messages';
import { SERVICE_IDENTITY_HEADER } from '@/modules/campaign-config-api/service-api-auth.guard';
import { provideMissingKeyMaterial } from '../campaigns/support/foreign-key-material';
import { ensureEncryptionKeys, removeEncryptionKeys } from '../auth/support/portal-user-fixture';
// Reused, read-only, from T-047's own e2e support — not this task's to own or edit, only to call:
// a throwaway mTLS CA/certs and a minimal gRPC client, so Verification step 2 ("boot the back-end
// with both gRPC and the new REST surface enabled; call the same campaign through both transports")
// is evidenced against a **real** gRPC wire round trip, not a second in-process service call.
import { createTestPki, type TestPki } from '../grpc/support/test-pki';
import { openSession, unary } from '../grpc/support/grpc-test-client';

jest.setTimeout(120_000);

const PREFIX = 'TINT010E2E';
const RUN = Date.now().toString(36);
const FULL_IDENTITY = `${PREFIX}_${RUN}_full.internal`;
const NARROW_IDENTITY = `${PREFIX}_${RUN}_narrow.internal`;

let app: INestApplication;
let db: Sequelize;
let configService: CampaignConfigService;
let apiToken: string;
let borrowedKeyVars: string[] = [];

let countryId: number;
let tenantId: number;
let adminUserId: number;
let portalUserId: number;
let ruleId: number;
let ruleVersionId: number;
let rewardId: number;
let rewardVersionId: number;
let campaignId: number;

async function sql<T extends object>(
  statement: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return db.query<T>(statement, { type: QueryTypes.SELECT, replacements });
}

async function exec(statement: string, replacements: Record<string, unknown> = {}): Promise<void> {
  await db.query(statement, { type: QueryTypes.RAW, replacements });
}

function http() {
  return request(app.getHttpServer());
}

/** A shallow copy of `source` without `keys` — used to drop the two fields TC-1's parity
 * assertion expects to legitimately differ (each call stamps its own `servedAt`/`etag`). */
function omit(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy = { ...source };
  for (const key of keys) delete copy[key];
  return copy;
}

/** A REST call carrying a valid bearer token + the given identity header. */
function apiGet(path: string, identity: string = FULL_IDENTITY) {
  return http()
    .get(`/api/v1/campaign-config${path}`)
    .set('Authorization', `Bearer ${apiToken}`)
    .set(SERVICE_IDENTITY_HEADER, identity);
}

async function purge(): Promise<void> {
  const campaigns = `SELECT id FROM reward_config.tenant_campaigns WHERE campaign_code LIKE '${PREFIX}%'`;
  const statements = [
    `DELETE FROM reward_config.campaign_caps WHERE campaign_id IN (${campaigns})`,
    `DELETE FROM reward_config.reward_campaign_assignments WHERE campaign_id IN (${campaigns})`,
    `DELETE FROM reward_config.tenant_campaigns WHERE campaign_code LIKE '${PREFIX}%'`,
    `DELETE FROM reward_config.rule_version_country_assignments WHERE rule_id IN (SELECT id FROM reward_config.rule_master WHERE rule_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.rule_country_assignments WHERE rule_id IN (SELECT id FROM reward_config.rule_master WHERE rule_code LIKE '${PREFIX}%')`,
    // `fn_rule_version_undeletable`/`fn_reward_version_undeletable` (reward_config triggers)
    // refuse to DELETE any version row whose `status <> 'draft'` — "deprecate or retire it
    // instead" — and this fixture deliberately inserts `published` versions (TC-1/TC-3 need a
    // real, servable version). The UPDATE below is cleanup-only, run after every test in this
    // file has already read the real `published` row; it never runs during the test body itself.
    `UPDATE reward_config.rule_versions SET status = 'draft'
      WHERE rule_id IN (SELECT id FROM reward_config.rule_master WHERE rule_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.rule_versions WHERE rule_id IN (SELECT id FROM reward_config.rule_master WHERE rule_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.rule_master WHERE rule_code LIKE '${PREFIX}%'`,
    `DELETE FROM reward_config.reward_version_country_assignments WHERE reward_id IN (SELECT id FROM reward_config.reward_systems WHERE system_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.reward_country_assignments WHERE reward_id IN (SELECT id FROM reward_config.reward_systems WHERE system_code LIKE '${PREFIX}%')`,
    `UPDATE reward_config.reward_versions SET status = 'draft'
      WHERE reward_id IN (SELECT id FROM reward_config.reward_systems WHERE system_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.reward_versions WHERE reward_id IN (SELECT id FROM reward_config.reward_systems WHERE system_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.reward_policies WHERE reward_system_id IN (SELECT id FROM reward_config.reward_systems WHERE system_code LIKE '${PREFIX}%')`,
    `DELETE FROM reward_config.reward_systems WHERE system_code LIKE '${PREFIX}%'`,
    `DELETE FROM reward_config.tenants WHERE code LIKE '${PREFIX}%'`,
    // Revoked, not deleted — `T047_001` revokes DELETE on this table by design (see this file's
    // header and `grpc.e2e-spec.ts`'s own comment on the same constraint).
    `UPDATE reward_portal.grpc_service_grants SET status = 'revoked'
      WHERE service_identity LIKE '${PREFIX}%'`,
  ];
  for (const statement of statements) await exec(statement);
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), 'tint010');
  borrowedKeyVars = await provideMissingKeyMaterial(moduleRef.get<Sequelize>(SEQUELIZE));

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
  configService = app.get(CampaignConfigService);

  const configured = process.env.CAMPAIGN_CONFIG_API_TOKEN;
  if (configured === undefined || configured === '') {
    throw new Error(
      'CAMPAIGN_CONFIG_API_TOKEN is not set — add it to portal/back-end/.env.development (see ' +
        'env.schema.ts) before running this suite.',
    );
  }
  apiToken = configured;

  await purge();

  const [admin] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.admin_users ORDER BY id LIMIT 1',
  );
  if (admin === undefined) throw new Error('no admin_users rows — cannot author fixture versions');
  adminUserId = admin.id;

  const [portalUser] = await sql<{ id: number }>(
    `SELECT id FROM reward_portal.portal_users
      WHERE split_part(email, '.', 2) IN (SELECT kid FROM reward_portal.encryption_keys)
      ORDER BY id LIMIT 1`,
  );
  if (portalUser === undefined) {
    throw new Error(
      'no portal_users rows — grpc_service_grants.created_by has a real foreign key.',
    );
  }
  portalUserId = portalUser.id;

  const [country] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries ORDER BY id LIMIT 1',
  );
  if (country === undefined) throw new Error('no countries — run the seed migrations first');
  countryId = country.id;

  const [tenant] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active') RETURNING id`,
    { code: `${PREFIX}_TENANT`, countryId },
  );
  tenantId = tenant.id;

  // --- one published rule version -------------------------------------------------------------
  const [subCategory] = await sql<{ id: number }>(
    `SELECT rsc.id FROM reward_config.rule_sub_categories rsc
       JOIN reward_config.rule_categories rc ON rc.id = rsc.category_id
      WHERE rc.category_code = 'TRANSACTION' AND rsc.sub_category_code = 'GENERAL' LIMIT 1`,
  );
  const parameters = JSON.stringify({ fields: [] });
  const [rule] = await sql<{ id: number }>(
    `INSERT INTO reward_config.rule_master (tenant_id, sub_category_id, rule_code, name, expression, parameters, status)
     VALUES (NULL, :subCategoryId, :code, :code, 'amount >= 1', :parameters, 'active') RETURNING id`,
    { subCategoryId: subCategory.id, code: `${PREFIX}_RULE`, parameters },
  );
  ruleId = rule.id;
  await exec(
    `INSERT INTO reward_config.rule_country_assignments (rule_id, country_id, assigned_by)
     VALUES (:ruleId, :countryId, :adminUserId)`,
    { ruleId, countryId, adminUserId },
  );
  const [ruleVersion] = await sql<{ id: number }>(
    `INSERT INTO reward_config.rule_versions
       (rule_id, version_no, expression, parameters, status, created_by, published_by, published_at)
     VALUES (:ruleId, 1, 'amount >= 1', :parameters, 'published', :adminUserId, :adminUserId, now())
     RETURNING id`,
    { ruleId, parameters, adminUserId },
  );
  ruleVersionId = ruleVersion.id;
  await exec(
    `INSERT INTO reward_config.rule_version_country_assignments
       (rule_version_id, rule_id, country_id, status, assigned_by, assigned_at)
     VALUES (:versionId, :ruleId, :countryId, 'active', :adminUserId, now())`,
    { versionId: ruleVersionId, ruleId, countryId, adminUserId },
  );

  // --- one published reward version -------------------------------------------------------------
  const [reward] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_systems
       (tenant_id, system_code, name, reward_type, connector_type, status)
     VALUES (NULL, :code, :code, 'cashback', 'internal', 'active') RETURNING id`,
    { code: `${PREFIX}_RWD` },
  );
  rewardId = reward.id;
  await exec(
    `INSERT INTO reward_config.reward_country_assignments (reward_id, country_id, assigned_by)
     VALUES (:rewardId, :countryId, :adminUserId)`,
    { rewardId, countryId, adminUserId },
  );
  const [rewardVersion] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_versions
       (reward_id, version_no, delivery_mode, policies_snapshot, unit_type, unit_code, status,
        created_by, published_by, published_at)
     VALUES (:rewardId, 1, 'instant', :snapshot, 'currency', 'MYR', 'published',
             :adminUserId, :adminUserId, now()) RETURNING id`,
    { rewardId, snapshot: JSON.stringify({ rate: '0.05' }), adminUserId },
  );
  rewardVersionId = rewardVersion.id;

  // --- one active campaign with a cap -------------------------------------------------------------
  const [campaign] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenant_campaigns
       (tenant_id, campaign_code, name, start_date, end_date, status, max_participants,
        budget_amount, budget_currency, created_by, approved_at, definition_pinned_at)
     VALUES (:tenantId, :code, :code, '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z', 'active', 100,
             '10000.00', 'MYR', '1', now(), now()) RETURNING id`,
    { tenantId, code: `${PREFIX}_CAMPAIGN` },
  );
  campaignId = campaign.id;
  await exec(
    `INSERT INTO reward_config.campaign_caps
       (tenant_id, campaign_id, cap_class, scope_level, period_type, unit_type, unit_code,
        max_total_amount, on_breach, warn_at_percent, status, created_by)
     VALUES (:tenantId, :campaignId, 'budget', 'campaign', 'lifetime', 'currency', 'MYR',
             '10000.00', 'pause_campaign', 80, 'active', :adminUserId)`,
    { tenantId, campaignId, adminUserId },
  );

  // --- grants: one full, one narrow (no RULES) for TC-9 --------------------------------------
  const grantFixture = async (identity: string, sections: string[]): Promise<void> => {
    await exec(
      `INSERT INTO reward_portal.grpc_service_grants
         (service_identity, tenant_id, allowed_sections, status, created_by)
       VALUES (:identity, :tenantId, CAST(:sections AS jsonb), 'active', :createdBy)
       ON CONFLICT (service_identity, tenant_key)
       DO UPDATE SET allowed_sections = EXCLUDED.allowed_sections, status = 'active'`,
      { identity, tenantId, sections: JSON.stringify(sections), createdBy: portalUserId },
    );
  };
  await grantFixture(FULL_IDENTITY, ['BASIC', 'RULES', 'REWARDS', 'CAPS']);
  await grantFixture(NARROW_IDENTITY, ['BASIC']);
}, 60_000);

afterAll(async () => {
  try {
    if (db !== undefined) {
      await purge();
      await removeEncryptionKeys(db, 'tint010').catch(() => undefined);
    }
    for (const name of borrowedKeyVars) delete process.env[name];
  } finally {
    await app?.close();
  }
});

function caller(identity: string, sections: readonly ConfigSectionName[]): ResolvedServiceIdentity {
  return {
    identity,
    grants: [
      {
        id: -1,
        serviceIdentity: identity,
        tenantId,
        allowedSections: sections,
        status: 'active',
        createdBy: portalUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  };
}

describe('TC-1: REST and gRPC serve field-identical CampaignConfig', () => {
  it('matches the real CampaignConfigService.getCampaignConfig call field-for-field', async () => {
    const { config: expected } = await configService.getCampaignConfig(
      caller(FULL_IDENTITY, ['BASIC', 'RULES', 'REWARDS', 'CAPS']),
      { tenantId, campaignCode: `${PREFIX}_CAMPAIGN`, etag: '', sections: [] },
    );

    const response = await apiGet(`/tenants/${tenantId}/campaigns/${PREFIX}_CAMPAIGN`).expect(200);

    // `servedAt`/`etag` legitimately differ between the two independent calls (each stamps its
    // own timestamp); every other field must be identical — that is the parity claim.
    expect(omit(response.body.data as Record<string, unknown>, ['servedAt', 'etag'])).toEqual(
      omit(expected as Record<string, unknown>, ['servedAt', 'etag']),
    );
  });
});

describe('Verification step 2: gRPC and REST both live in one process, over the real wire', () => {
  // A second, throwaway mTLS listener built from the *same* `InternalServiceBootstrap` provider
  // `main.ts` uses (`internal-service.bootstrap.ts#build`, exposed for exactly this) — proving the
  // REST module coexists with the gRPC one in a single boot (no port/DI collision), and giving
  // TC-1's parity claim a genuine gRPC-encoded wire response to compare against, not a second
  // direct call to the same TypeScript method.
  let pki: TestPki;
  let listener: InternalTlsListener;
  let session: ClientHttp2Session;

  beforeAll(async () => {
    pki = createTestPki();
    process.env.GRPC_TLS_CERT_PATH = pki.server.certPath;
    process.env.GRPC_TLS_KEY_PATH = pki.server.keyPath;
    process.env.GRPC_TLS_CA_PATH = pki.caPath;

    listener = app.get(InternalServiceBootstrap).build({ port: 0, host: '127.0.0.1' });
    await listener.listen();

    const clientCert = pki.client(FULL_IDENTITY);
    session = await openSession({
      port: listener.address(),
      ca: pki.ca,
      cert: clientCert.cert,
      key: clientCert.key,
    });
  }, 30_000);

  afterAll(async () => {
    session?.close();
    await listener?.close();
    pki?.destroy();
    delete process.env.GRPC_TLS_CERT_PATH;
    delete process.env.GRPC_TLS_KEY_PATH;
    delete process.env.GRPC_TLS_CA_PATH;
  });

  it('a real gRPC GetCampaignConfig call and a real REST call serve field-identical data', async () => {
    const request = encodeMessage(GetCampaignConfigRequestMessage, {
      tenantId,
      campaignCode: `${PREFIX}_CAMPAIGN`,
      etag: '',
      sections: [],
    });
    const grpcResult = await unary(
      session,
      `/${GRPC_SERVICE_FULL_NAME}/${GRPC_METHOD.GET_CAMPAIGN_CONFIG}`,
      request,
    );
    expect(grpcResult.grpcStatus).toBe(GrpcStatus.OK);
    const decoded = decodeMessage(CampaignConfigMessage, grpcResult.messages[0]) as Record<
      string,
      unknown
    >;

    const restResponse = await apiGet(`/tenants/${tenantId}/campaigns/${PREFIX}_CAMPAIGN`).expect(
      200,
    );

    expect(omit(decoded, ['servedAt', 'etag'])).toEqual(
      omit(restResponse.body.data as Record<string, unknown>, ['servedAt', 'etag']),
    );
  });
});

describe('TC-2: ListActiveCampaigns REST equivalent', () => {
  it("lists only the active campaign, matching the gRPC RPC's own active-only filter", async () => {
    const response = await apiGet(`/tenants/${tenantId}/campaigns`).expect(200);
    const codes = (response.body.data.campaigns as { campaignCode: string }[]).map(
      (entry) => entry.campaignCode,
    );
    expect(codes).toEqual([`${PREFIX}_CAMPAIGN`]);
  });
});

describe('TC-3: ResolveRuleVersion / ResolveRewardVersion REST equivalents', () => {
  it('resolves a real, published rule version', async () => {
    const response = await apiGet(`/tenants/${tenantId}/rules/${ruleId}/versions/1`).expect(200);
    expect(response.body.data).toMatchObject({ exists: true, ruleId, ruleVersionId, versionNo: 1 });
  });

  it('resolves a real, published reward version', async () => {
    const response = await apiGet(`/tenants/${tenantId}/rewards/${rewardId}/versions/1`).expect(
      200,
    );
    expect(response.body.data).toMatchObject({
      exists: true,
      rewardId,
      rewardVersionId,
      versionNo: 1,
    });
  });

  it('an unknown version number resolves as exists:false, not a 404', async () => {
    const response = await apiGet(`/tenants/${tenantId}/rules/${ruleId}/versions/999`).expect(200);
    expect(response.body.data).toEqual({ exists: false });
  });
});

describe('TC-4: GetBudgetStatus REST equivalent', () => {
  it('matches the real, real-time cap entry', async () => {
    const response = await apiGet(
      `/tenants/${tenantId}/campaigns/${PREFIX}_CAMPAIGN/budget-status`,
    ).expect(200);
    expect(response.body.data.entries).toHaveLength(1);
    expect(response.body.data.entries[0]).toMatchObject({
      capClass: 'budget',
      // `campaign_caps.max_total_amount` is `numeric` with 4 decimal places in the schema, so the
      // real-time value read back is '10000.0000', not the 2-decimal literal this fixture wrote.
      maxTotalAmount: '10000.0000',
      onBreach: 'pause_campaign',
    });
  });
});

describe('TC-5 / TC-6: ETag polling', () => {
  it('TC-6: a stale (absent) etag answers 200 with a full payload and a fresh ETag header', async () => {
    const response = await apiGet(`/tenants/${tenantId}/campaigns/${PREFIX}_CAMPAIGN`).expect(200);
    expect(response.headers.etag).toBeTruthy();
    expect(response.body.data.notModified).toBe(false);
  });

  it('TC-5: presenting that same etag back answers 304 with no body', async () => {
    const first = await apiGet(`/tenants/${tenantId}/campaigns/${PREFIX}_CAMPAIGN`).expect(200);
    const etag = first.headers.etag as string;

    const second = await http()
      .get(`/api/v1/campaign-config/tenants/${tenantId}/campaigns/${PREFIX}_CAMPAIGN`)
      .set('Authorization', `Bearer ${apiToken}`)
      .set(SERVICE_IDENTITY_HEADER, FULL_IDENTITY)
      .set('If-None-Match', etag)
      .expect(304);

    expect(second.body).toEqual({});
    expect(second.headers.etag).toBe(etag);
  });
});

describe('TC-7 (negative): missing or invalid service bearer token', () => {
  it('no Authorization header at all → 401, no campaign data leaked', async () => {
    const response = await http()
      .get(`/api/v1/campaign-config/tenants/${tenantId}/campaigns/${PREFIX}_CAMPAIGN`)
      .set(SERVICE_IDENTITY_HEADER, FULL_IDENTITY)
      .expect(401);
    expect(response.body.data).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(PREFIX);
  });

  it('a wrong bearer token → 401, no campaign data leaked', async () => {
    const response = await http()
      .get(`/api/v1/campaign-config/tenants/${tenantId}/campaigns/${PREFIX}_CAMPAIGN`)
      .set('Authorization', 'Bearer definitely-not-the-configured-token')
      .set(SERVICE_IDENTITY_HEADER, FULL_IDENTITY)
      .expect(401);
    expect(response.body.data).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(PREFIX);
  });
});

describe('TC-8 (negative): a portal browser-session cookie sent instead of a service token', () => {
  it('rejects the same way assertNoPortalCredentials does on the gRPC transport', async () => {
    await http()
      .get(`/api/v1/campaign-config/tenants/${tenantId}/campaigns/${PREFIX}_CAMPAIGN`)
      .set('Cookie', '__Host-rs_at=whatever-a-portal-session-cookie-looks-like')
      .set('Authorization', `Bearer ${apiToken}`)
      .set(SERVICE_IDENTITY_HEADER, FULL_IDENTITY)
      .expect(401);
  });
});

describe('TC-9 (negative): valid token, no grant for the requested section', () => {
  it('an identity granted only BASIC gets 403 asking for RULES explicitly', async () => {
    await http()
      .get(
        `/api/v1/campaign-config/tenants/${tenantId}/campaigns/${PREFIX}_CAMPAIGN` +
          '?sections=RULES',
      )
      .set('Authorization', `Bearer ${apiToken}`)
      .set(SERVICE_IDENTITY_HEADER, NARROW_IDENTITY)
      .expect(403);
  });

  it('an identity with no grant at all is 401 (unknown identity), matching gRPC UNAUTHENTICATED', async () => {
    await http()
      .get(`/api/v1/campaign-config/tenants/${tenantId}/campaigns/${PREFIX}_CAMPAIGN`)
      .set('Authorization', `Bearer ${apiToken}`)
      .set(SERVICE_IDENTITY_HEADER, `${PREFIX}_${RUN}_unknown.internal`)
      .expect(401);
  });
});
