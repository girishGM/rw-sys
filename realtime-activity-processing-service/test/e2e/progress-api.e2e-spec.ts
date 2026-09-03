/**
 * T-RAP-040. TC-1/TC-2/TC-3/TC-5 (`tasks/T-RAP-040-progress-api.md`) — driven through the real
 * HTTP stack (`ProgressApiRootModule`, `progress-api-server.main.ts`'s own composition root)
 * against the real local Postgres 16 server (root `CLAUDE.md`), connected as the real
 * least-privilege `rap_app` role. Seed data is written directly to the tables this module reads
 * (`progress-api-test-helpers.ts`) rather than driven through the Wave 3 write pipeline — this
 * module is entirely read-only, so that pipeline is out of scope for its own tests (Scope "Out").
 *
 * TC-4 (10,000+ row latency + `EXPLAIN ANALYZE`) lives in its own file,
 * `progress-api-perf.e2e-spec.ts` — kept separate so a normal `npm test` run doesn't pay that
 * seed's cost every time.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import request from 'supertest';
import { ProgressApiRootModule } from '@/modules/progress-api/progress-api-server.main';
import {
  EncryptionService,
  loadEncryptionKeyMaterial,
} from '@/modules/encryption/encryption.service';
import {
  loadProgressApiAuthSecret,
  signProgressApiToken,
} from '@/modules/progress-api/progress-api-token';
import {
  buildTestSequelize,
  cleanupTenant,
  seedCampaignConfigSnapshot,
  seedComponentProgress,
  seedTrackerStatus,
} from './progress-api-test-helpers';

const AES_KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 9).toString('base64');
const AUTH_SECRET_B64 = Buffer.alloc(32, 11).toString('base64');

const TENANT_ID = 960_000 + Math.floor(Math.random() * 30_000);

describe('Customer progress API (e2e, real Postgres, rap_app role)', () => {
  let app: INestApplication;
  let sequelize: Sequelize;
  let encryption: EncryptionService;

  beforeAll(async () => {
    process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
    process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;
    process.env.PROGRESS_API_AUTH_SECRET = AUTH_SECRET_B64;

    const moduleRef = await Test.createTestingModule({
      imports: [ProgressApiRootModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    sequelize = buildTestSequelize();
    encryption = new EncryptionService(loadEncryptionKeyMaterial());
  });

  afterAll(async () => {
    await cleanupTenant(sequelize, TENANT_ID);
    await sequelize.close();
    await app.close();
  });

  function tokenFor(customerId: string, tenantId = TENANT_ID, expiresInSeconds = 3600): string {
    return signProgressApiToken(
      { tenantId, customerId, exp: Math.floor(Date.now() / 1000) + expiresInSeconds },
      loadProgressApiAuthSecret(),
    );
  }

  it('TC-1: in-progress components on one campaign return accurate current/required counts', async () => {
    const customerId = 'cust-tc1';
    const customerIdHash = encryption.hash(customerId);
    await seedCampaignConfigSnapshot(sequelize, TENANT_ID, 'CAMP_TC1', [
      { trackerCode: 'TRK1', completionLogic: 'all' },
    ]);
    await seedComponentProgress(sequelize, {
      tenantId: TENANT_ID,
      customerIdHash,
      campaignCode: 'CAMP_TC1',
      trackerCode: 'TRK1',
      trackerComponentCode: 'COMP1',
      currentCount: 1,
      requiredCount: 3,
    });

    const response = await request(app.getHttpServer())
      .get(`/progress/customers/${customerId}/campaigns/CAMP_TC1`)
      .set('Authorization', `Bearer ${tokenFor(customerId)}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      customerId,
      campaignCode: 'CAMP_TC1',
      trackers: [
        {
          trackerCode: 'TRK1',
          completionLogic: 'all',
          isCompleted: false,
          completedAt: null,
          componentsRequiredCount: 1,
          componentsCompletedCount: 0,
          components: [
            { componentCode: 'COMP1', currentCount: 1, requiredCount: 3, isCompleted: false },
          ],
        },
      ],
    });
  });

  it('TC-2: a completed tracker reports is_completed true with completedAt populated', async () => {
    const customerId = 'cust-tc2';
    const customerIdHash = encryption.hash(customerId);
    await seedCampaignConfigSnapshot(sequelize, TENANT_ID, 'CAMP_TC2', [
      { trackerCode: 'TRK2', completionLogic: 'any' },
    ]);
    await seedComponentProgress(sequelize, {
      tenantId: TENANT_ID,
      customerIdHash,
      campaignCode: 'CAMP_TC2',
      trackerCode: 'TRK2',
      trackerComponentCode: 'COMP2',
      currentCount: 1,
      requiredCount: 1,
      isCompleted: true,
    });
    await seedTrackerStatus(sequelize, {
      tenantId: TENANT_ID,
      customerIdHash,
      campaignCode: 'CAMP_TC2',
      trackerCode: 'TRK2',
      componentsRequiredCount: 1,
      componentsCompletedCount: 1,
      isCompleted: true,
    });

    const response = await request(app.getHttpServer())
      .get(`/progress/customers/${customerId}/campaigns/CAMP_TC2/trackers/TRK2`)
      .set('Authorization', `Bearer ${tokenFor(customerId)}`);

    expect(response.status).toBe(200);
    expect(response.body.trackerCode).toBe('TRK2');
    expect(response.body.isCompleted).toBe(true);
    expect(response.body.completedAt).not.toBeNull();
    expect(typeof response.body.completedAt).toBe('string');
    expect(response.body.components).toEqual([
      { componentCode: 'COMP2', currentCount: 1, requiredCount: 1, isCompleted: true },
    ]);
  });

  it('TC-3: no activity on the requested campaign returns an empty/zeroed response, not an error', async () => {
    const customerId = 'cust-tc3';

    const campaignResponse = await request(app.getHttpServer())
      .get(`/progress/customers/${customerId}/campaigns/CAMP_NEVER_TOUCHED`)
      .set('Authorization', `Bearer ${tokenFor(customerId)}`);
    expect(campaignResponse.status).toBe(200);
    expect(campaignResponse.body).toEqual({
      customerId,
      campaignCode: 'CAMP_NEVER_TOUCHED',
      trackers: [],
    });

    const trackerResponse = await request(app.getHttpServer())
      .get(
        `/progress/customers/${customerId}/campaigns/CAMP_NEVER_TOUCHED/trackers/TRK_NEVER_TOUCHED`,
      )
      .set('Authorization', `Bearer ${tokenFor(customerId)}`);
    expect(trackerResponse.status).toBe(200);
    expect(trackerResponse.body).toEqual({
      customerId,
      campaignCode: 'CAMP_NEVER_TOUCHED',
      trackerCode: 'TRK_NEVER_TOUCHED',
      completionLogic: null,
      isCompleted: false,
      completedAt: null,
      componentsRequiredCount: 0,
      componentsCompletedCount: 0,
      components: [],
    });
  });

  describe('TC-5: unauthorized access', () => {
    it('rejects a request with no Authorization header at all', async () => {
      const response = await request(app.getHttpServer()).get(
        '/progress/customers/cust-tc5/campaigns/CAMP_TC5',
      );
      expect(response.status).toBe(401);
    });

    it('rejects a request with a malformed/garbage bearer token', async () => {
      const response = await request(app.getHttpServer())
        .get('/progress/customers/cust-tc5/campaigns/CAMP_TC5')
        .set('Authorization', 'Bearer not-a-real-token');
      expect(response.status).toBe(401);
    });

    it('rejects a request with an expired token', async () => {
      const expired = signProgressApiToken(
        { tenantId: TENANT_ID, customerId: 'cust-tc5', exp: Math.floor(Date.now() / 1000) - 10 },
        loadProgressApiAuthSecret(),
      );
      const response = await request(app.getHttpServer())
        .get('/progress/customers/cust-tc5/campaigns/CAMP_TC5')
        .set('Authorization', `Bearer ${expired}`);
      expect(response.status).toBe(401);
    });

    it('rejects a token forged with the wrong secret', async () => {
      const forged = signProgressApiToken(
        { tenantId: TENANT_ID, customerId: 'cust-tc5', exp: Math.floor(Date.now() / 1000) + 3600 },
        Buffer.alloc(32, 99),
      );
      const response = await request(app.getHttpServer())
        .get('/progress/customers/cust-tc5/campaigns/CAMP_TC5')
        .set('Authorization', `Bearer ${forged}`);
      expect(response.status).toBe(401);
    });

    it('rejects a valid token for a DIFFERENT customerId than the one in the URL (cross-customer access attempt)', async () => {
      const tokenForSomeoneElse = tokenFor('cust-someone-else');
      const response = await request(app.getHttpServer())
        .get('/progress/customers/cust-tc5-victim/campaigns/CAMP_TC5')
        .set('Authorization', `Bearer ${tokenForSomeoneElse}`);
      expect(response.status).toBe(403);
    });

    it('accepts a valid token whose own customerId matches the URL', async () => {
      const response = await request(app.getHttpServer())
        .get('/progress/customers/cust-tc5/campaigns/CAMP_TC5')
        .set('Authorization', `Bearer ${tokenFor('cust-tc5')}`);
      expect(response.status).toBe(200);
    });
  });
});
