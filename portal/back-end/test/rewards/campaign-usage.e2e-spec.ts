/**
 * T-032 TC-9 — `findActiveCampaignsUsingRewardInCountry` against the real Postgres instance,
 * through the real `reward_campaign_assignments` → `reward_policies` → `tenant_campaigns` →
 * `tenants` chain (`campaign-usage.query.ts`'s own header explains why this join is a raw,
 * parameterised query rather than a `ScopedRepository` call — and why it needed no T-037
 * escalation, unlike the rule side's tracker/component chain).
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
import { findActiveCampaignsUsingRewardInCountry } from '@/modules/rewards/campaign-usage.query';
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

const T032CU_SUITE = 't032cu';
const PASSWORD = 'correct horse battery staple 7!';
const COUNTRY_CODE = 'RW';
const TENANT_CODE = 'T032CU_E2E_T';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let countryId: number;
let tenantId: number;
let rewardSystemId: number;
let rewardPolicyId: number;
let campaignId: number;
let rewardCampaignAssignmentId: number;
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
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), T032CU_SUITE);

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
       VALUES (:code, 'T-032 campaign-usage e2e country', 'UTC', 'USD', '+001', 'active')
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

  const [system] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_systems
        (tenant_id, system_code, name, reward_type, delivery_mode, connector_type, status)
     VALUES (NULL, :code, 'T-032 campaign-usage e2e reward', 'monetary', 'realtime',
             'internal_api', 'active')
     RETURNING id`,
    { code: `T032CU_${String(Date.now())}` },
  );
  rewardSystemId = system.id;

  const [policy] = await sql<{ id: number }>(
    `INSERT INTO reward_config.reward_policies (reward_system_id, policy_code, name, status)
     VALUES (:rewardSystemId, :code, 'T-032 e2e policy', 'active')
     RETURNING id`,
    { rewardSystemId, code: `T032CU_POL_${String(Date.now())}` },
  );
  rewardPolicyId = policy.id;

  const email = 't032cu-e2e-super@example.invalid';
  await deletePortalUsersByEmail(db, emailCrypto, [email]);
  superUserId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: 'T-032 campaign-usage super',
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

/**
 * `try/finally` around every cleanup statement, guaranteeing `app.close()` always runs even if a
 * DELETE fails (a new FK, a locked row, anything) — see `rewards.e2e-spec.ts`'s `afterAll` header
 * for the concrete incident this defends against: a cleanup statement throwing *before*
 * `app.close()` left the real Nest HTTP server and Sequelize pool open, which hung the whole Jest
 * worker process indefinitely rather than failing the suite fast. This file has no
 * `reward_policy_caps` row to race (it never calls the caps endpoints), but the shutdown-ordering
 * fragility that let that failure mode happen at all is a property of the `afterAll` shape, not of
 * this file's specific fixtures, so it gets the same defence.
 */
afterAll(async () => {
  try {
    if (db !== undefined) {
      if (rewardCampaignAssignmentId !== undefined) {
        await exec('DELETE FROM reward_config.reward_campaign_assignments WHERE id = :id', {
          id: rewardCampaignAssignmentId,
        });
      }
      if (campaignId !== undefined) {
        await exec('DELETE FROM reward_config.tenant_campaigns WHERE id = :id', { id: campaignId });
      }
      await exec(
        'DELETE FROM reward_config.reward_country_assignments WHERE reward_id = :rewardId',
        {
          rewardId: rewardSystemId,
        },
      );
      if (rewardPolicyId !== undefined) {
        await exec('DELETE FROM reward_config.reward_policies WHERE id = :id', {
          id: rewardPolicyId,
        });
      }
      if (rewardSystemId !== undefined) {
        await exec('DELETE FROM reward_config.reward_systems WHERE id = :id', {
          id: rewardSystemId,
        });
      }
      if (superUserId !== undefined) {
        await exec('DELETE FROM reward_portal.portal_users WHERE id = :id', { id: superUserId });
      }
      await removeEncryptionKeys(db, T032CU_SUITE);
    }
  } finally {
    if (app !== undefined) await app.close();
  }
});

describe('T-032 — findActiveCampaignsUsingRewardInCountry (TC-9)', () => {
  it('returns nothing when the reward is bound to no campaign at all', async () => {
    const result = await findActiveCampaignsUsingRewardInCountry(db, rewardSystemId, countryId);
    expect(result).toEqual([]);
  });

  it('returns the campaign once reward_campaign_assignments binds the policy to it', async () => {
    const [campaign] = await sql<{ id: number; name: string }>(
      `INSERT INTO reward_config.tenant_campaigns
              (tenant_id, campaign_code, name, start_date, end_date, status, created_by)
       VALUES (:tenantId, :code, 'T-032 e2e active campaign',
               now(), now() + interval '30 days', 'active', 'T032_e2e')
       RETURNING id, name`,
      { tenantId, code: `T032CU_CAMP_${String(Date.now())}` },
    );
    campaignId = campaign.id;

    const [rca] = await sql<{ id: number }>(
      `INSERT INTO reward_config.reward_campaign_assignments
              (tenant_id, reward_policy_id, campaign_id, status)
       VALUES (:tenantId, :rewardPolicyId, :campaignId, 'active')
       RETURNING id`,
      { tenantId, rewardPolicyId, campaignId },
    );
    rewardCampaignAssignmentId = rca.id;

    const result = await findActiveCampaignsUsingRewardInCountry(db, rewardSystemId, countryId);
    expect(result).toEqual([{ id: campaignId, name: campaign.name }]);
  });

  it('the campaign disappears once the assignment is deactivated, and is restored after', async () => {
    await exec(
      `UPDATE reward_config.reward_campaign_assignments SET status = 'inactive' WHERE id = :id`,
      { id: rewardCampaignAssignmentId },
    );

    expect(await findActiveCampaignsUsingRewardInCountry(db, rewardSystemId, countryId)).toEqual(
      [],
    );

    await exec(
      `UPDATE reward_config.reward_campaign_assignments SET status = 'active' WHERE id = :id`,
      { id: rewardCampaignAssignmentId },
    );
    expect(await findActiveCampaignsUsingRewardInCountry(db, rewardSystemId, countryId)).toEqual([
      { id: campaignId, name: expect.any(String) as unknown as string },
    ]);
  });

  it('a campaign in a different country is never returned', async () => {
    const [otherCountry] = await sql<{ id: number }>(
      `SELECT id FROM reward_config.countries WHERE code = 'MY'`,
    );
    if (otherCountry === undefined) return;

    const result = await findActiveCampaignsUsingRewardInCountry(
      db,
      rewardSystemId,
      otherCountry.id,
    );
    expect(result).toEqual([]);
  });
});

/**
 * The real `DELETE /rewards/:id/countries/:countryId` over HTTP, with a real logged-in
 * super_admin — proving the query this file otherwise tests directly genuinely feeds
 * `RewardsService.unassignFromCountry`'s 422, not just a standalone SELECT (TC-9).
 */
describe('T-032 — TC-9 over HTTP', () => {
  it('unassigning a reward bound to an active campaign → 422 listing the campaign, assignment intact', async () => {
    await exec(
      `INSERT INTO reward_config.reward_country_assignments (reward_id, country_id, assigned_by)
       VALUES (:rewardId, :countryId, NULL)
       ON CONFLICT DO NOTHING`,
      { rewardId: rewardSystemId, countryId },
    );

    const response = await request(app.getHttpServer())
      .delete(`/api/v1/rewards/${String(rewardSystemId)}/countries/${String(countryId)}`)
      .set('Cookie', superJar)
      .set('X-CSRF-Token', superCsrf);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('REWARD_IN_USE_BY_CAMPAIGN');
    expect(response.body.error.details).toEqual([
      { field: 'campaignId', code: `CAMPAIGN_${String(campaignId)}` },
    ]);

    const [row] = await sql<{ id: number }>(
      'SELECT id FROM reward_config.reward_country_assignments WHERE reward_id = :rewardId AND country_id = :countryId',
      { rewardId: rewardSystemId, countryId },
    );
    expect(row).toBeDefined();
  });
});
