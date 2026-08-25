/**
 * T-031 implementation note 6 / TC-12 — `findActiveCampaignsUsingRuleInCountry` against the
 * real Postgres instance, through the real `tracker_component_rules` → `tracker_components` →
 * `tracker_tracker_components` → `trackers` → `tenant_campaign_trackers` → `tenant_campaigns`
 * chain (`campaign-usage.query.ts`'s own header explains why this join is a raw,
 * parameterised query rather than a `ScopedRepository` call).
 *
 * T-037 (the campaign wizard) has not shipped at the time this suite was written, so nothing
 * else in the application can produce these rows yet — this suite builds the whole chain by
 * hand, through the same real, privilege-checked tables the query itself reads, to prove the
 * join is correct today and stays correct once T-037 starts writing to it for real.
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
import { findActiveCampaignsUsingRuleInCountry } from '@/modules/rules/campaign-usage.query';
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

const T031CU_SUITE = 't031cu';
const PASSWORD = 'correct horse battery staple 7!';
const COUNTRY_CODE = 'RU';
const TENANT_CODE = 'T031CU_E2E_T';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let countryId: number;
let tenantId: number;
let ruleId: number;
let trackerComponentId: number;
let trackerId: number;
let campaignId: number;
let campaignTrackerId: number;
let tenantCampaignTrackerId: number;
let tcrId: number;
let superUserId: number;
let superJar: string;
let superCsrf: string;

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

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), T031CU_SUITE);

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

  const [country] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries WHERE code = :code',
    { code: COUNTRY_CODE },
  );
  if (country !== undefined) {
    countryId = country.id;
  } else {
    const [created] = await sql<{ id: number }>(
      `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
       VALUES (:code, 'T-031 campaign-usage e2e country', 'UTC', 'USD', '+001', 'active')
       RETURNING id`,
      { code: COUNTRY_CODE },
    );
    countryId = created.id;
  }

  const [tenant] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.tenants WHERE code = :code',
    { code: TENANT_CODE },
  );
  if (tenant !== undefined) {
    tenantId = tenant.id;
    await exec(
      `UPDATE reward_config.tenants SET status = 'active', country_id = :countryId WHERE id = :id`,
      { id: tenantId, countryId },
    );
  } else {
    const [created] = await sql<{ id: number }>(
      `INSERT INTO reward_config.tenants (code, name, country_id, status)
       VALUES (:code, :code, :countryId, 'active') RETURNING id`,
      { code: TENANT_CODE, countryId },
    );
    tenantId = created.id;
  }

  const [subCategory] = await sql<{ id: number }>(
    `SELECT rsc.id
       FROM reward_config.rule_sub_categories rsc
       JOIN reward_config.rule_categories rc ON rc.id = rsc.category_id
      WHERE rc.category_code = 'TRANSACTION' AND rsc.sub_category_code = 'GENERAL'
      LIMIT 1`,
  );

  const [rule] = await sql<{ id: number }>(
    `INSERT INTO reward_config.rule_master (tenant_id, sub_category_id, rule_code, name, status)
     VALUES (NULL, :subCategoryId, :ruleCode, 'T-031 campaign-usage e2e rule', 'active')
     RETURNING id`,
    { subCategoryId: subCategory.id, ruleCode: `T031CU_${String(Date.now())}` },
  );
  ruleId = rule.id;

  const email = 't031cu-e2e-super@example.invalid';
  await deletePortalUsersByEmail(db, emailCrypto, [email]);
  superUserId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: 'T-031 campaign-usage super',
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
  if (login.status !== 200) {
    throw new Error(`super_admin login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  superJar = jarFrom(login);
  superCsrf = cookieValue(login, CSRF_COOKIE_NAME);
});

afterAll(async () => {
  if (db !== undefined) {
    if (tcrId !== undefined) {
      await exec('DELETE FROM reward_config.tracker_component_rules WHERE id = :id', { id: tcrId });
    }
    await exec('DELETE FROM reward_config.rule_country_assignments WHERE rule_id = :ruleId', {
      ruleId,
    });
    if (tenantCampaignTrackerId !== undefined) {
      await exec('DELETE FROM reward_config.tenant_campaign_trackers WHERE id = :id', {
        id: tenantCampaignTrackerId,
      });
    }
    if (campaignId !== undefined) {
      await exec('DELETE FROM reward_config.tenant_campaigns WHERE id = :id', { id: campaignId });
    }
    if (campaignTrackerId !== undefined) {
      await exec('DELETE FROM reward_config.tracker_tracker_components WHERE id = :id', {
        id: campaignTrackerId,
      });
    }
    if (trackerId !== undefined) {
      await exec('DELETE FROM reward_config.trackers WHERE id = :id', { id: trackerId });
    }
    if (trackerComponentId !== undefined) {
      await exec('DELETE FROM reward_config.tracker_components WHERE id = :id', {
        id: trackerComponentId,
      });
    }
    if (ruleId !== undefined) {
      await exec('DELETE FROM reward_config.rule_master WHERE id = :id', { id: ruleId });
    }
    if (superUserId !== undefined) {
      await exec('DELETE FROM reward_portal.portal_users WHERE id = :id', { id: superUserId });
    }
    await removeEncryptionKeys(db, T031CU_SUITE);
  }
  if (app !== undefined) await app.close();
});

describe('T-031 — findActiveCampaignsUsingRuleInCountry (TC-12)', () => {
  it('returns nothing when the rule is bound to no campaign at all', async () => {
    const result = await findActiveCampaignsUsingRuleInCountry(db, ruleId, countryId);
    expect(result).toEqual([]);
  });

  it('returns the campaign once the whole tracker/component chain binds the rule to it', async () => {
    const [component] = await sql<{ id: number }>(
      `INSERT INTO reward_config.tracker_components (tenant_id, component_code, name, status)
       VALUES (:tenantId, :code, 'T-031 e2e component', 'active') RETURNING id`,
      { tenantId, code: `T031CU_COMP_${String(Date.now())}` },
    );
    trackerComponentId = component.id;

    const [tracker] = await sql<{ id: number }>(
      `INSERT INTO reward_config.trackers (tenant_id, tracker_code, name, status)
       VALUES (:tenantId, :code, 'T-031 e2e tracker', 'active') RETURNING id`,
      { tenantId, code: `T031CU_TRK_${String(Date.now())}` },
    );
    trackerId = tracker.id;

    const [ttc] = await sql<{ id: number }>(
      `INSERT INTO reward_config.tracker_tracker_components (tracker_id, component_id, sequence_order)
       VALUES (:trackerId, :componentId, 1) RETURNING id`,
      { trackerId, componentId: trackerComponentId },
    );
    campaignTrackerId = ttc.id;

    const [campaign] = await sql<{ id: number; name: string }>(
      `INSERT INTO reward_config.tenant_campaigns
              (tenant_id, campaign_code, name, start_date, end_date, status, created_by)
       VALUES (:tenantId, :code, 'T-031 e2e active campaign',
               now(), now() + interval '30 days', 'active', 'T031_e2e')
       RETURNING id, name`,
      { tenantId, code: `T031CU_CAMP_${String(Date.now())}` },
    );
    campaignId = campaign.id;

    const [tct] = await sql<{ id: number }>(
      `INSERT INTO reward_config.tenant_campaign_trackers (tenant_id, campaign_id, tracker_id, status)
       VALUES (:tenantId, :campaignId, :trackerId, 'active') RETURNING id`,
      { tenantId, campaignId, trackerId },
    );
    tenantCampaignTrackerId = tct.id;

    const [tcr] = await sql<{ id: number }>(
      `INSERT INTO reward_config.tracker_component_rules (tenant_id, tracker_component_id, rule_id, status)
       VALUES (:tenantId, :componentId, :ruleId, 'active') RETURNING id`,
      { tenantId, componentId: trackerComponentId, ruleId },
    );
    tcrId = tcr.id;

    const result = await findActiveCampaignsUsingRuleInCountry(db, ruleId, countryId);
    expect(result).toEqual([{ id: campaignId, name: campaign.name }]);
  });

  it('the campaign disappears from the result once its tracker binding is deactivated, and is restored after', async () => {
    await exec(
      `UPDATE reward_config.tenant_campaign_trackers SET status = 'withdrawn' WHERE id = :id`,
      {
        id: tenantCampaignTrackerId,
      },
    );

    expect(await findActiveCampaignsUsingRuleInCountry(db, ruleId, countryId)).toEqual([]);

    await exec(
      `UPDATE reward_config.tenant_campaign_trackers SET status = 'active' WHERE id = :id`,
      {
        id: tenantCampaignTrackerId,
      },
    );
    expect(await findActiveCampaignsUsingRuleInCountry(db, ruleId, countryId)).toEqual([
      { id: campaignId, name: expect.any(String) as unknown as string },
    ]);
  });

  it('a campaign in a different country is never returned', async () => {
    const [otherCountry] = await sql<{ id: number }>(
      `SELECT id FROM reward_config.countries WHERE code = 'MY'`,
    );
    // `MY` (Malaysia) is the well-known HQ seed row — real, but unrelated to this rule.
    if (otherCountry === undefined) return;

    const result = await findActiveCampaignsUsingRuleInCountry(db, ruleId, otherCountry.id);
    expect(result).toEqual([]);
  });
});

/**
 * The real `DELETE /rules/:id/countries/:countryId` over HTTP, with a real logged-in
 * super_admin — proving the query this file otherwise tests directly genuinely feeds
 * `RuleService.unassignFromCountry`'s 422, not just a standalone SELECT. TC-12.
 */
describe('T-031 — TC-12 over HTTP', () => {
  it('unassigning a rule bound to an active campaign → 422 listing the campaign, assignment intact', async () => {
    // `assigned_by` is NULL here on purpose, not `superUserId` — `fk_rca_admin` references
    // `reward_config.admin_users`, a disjoint id space from `portal_users`
    // (`RulesService.resolveAdminUserId`'s own comment has the full reasoning).
    await exec(
      `INSERT INTO reward_config.rule_country_assignments (rule_id, country_id, assigned_by)
       VALUES (:ruleId, :countryId, NULL)
       ON CONFLICT DO NOTHING`,
      { ruleId, countryId },
    );

    const response = await request(app.getHttpServer())
      .delete(`/api/v1/rules/${String(ruleId)}/countries/${String(countryId)}`)
      .set('Cookie', superJar)
      .set('X-CSRF-Token', superCsrf);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('RULE_IN_USE_BY_CAMPAIGN');
    expect(response.body.error.details).toEqual([
      { field: 'campaignId', code: `CAMPAIGN_${String(campaignId)}` },
    ]);

    const [row] = await sql<{ id: number }>(
      'SELECT id FROM reward_config.rule_country_assignments WHERE rule_id = :ruleId AND country_id = :countryId',
      { ruleId, countryId },
    );
    expect(row).toBeDefined();
  });
});
