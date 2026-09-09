/**
 * T-RR-013. Real round trip: real HTTP (supertest) against the real, fully-wired `AppModule`
 * (`RewardEntriesModule` registered there by this task, `app.module.ts`'s own header), backed by
 * the real, already-migrated `reward_redemption` schema on the real local Postgres 16 server (root
 * `CLAUDE.md`) — same "assert the observable property, not the implementation string" discipline
 * `reward-ingest.e2e-spec.ts` (T-RR-011) already established for the gRPC leg, and the same
 * real-`AppModule` pattern `cache-invalidation.controller.spec.ts` (T-RR-007) already established
 * for this exact endpoint's sibling REST route.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { AppModule } from '@/app.module';
import { createMigrationConnection } from '@/database/migration-connection';

const TENANT_ID = 960_000 + Math.floor(Math.random() * 9_999);
const TOKEN = process.env.REWARD_ENTRY_INGEST_TOKEN;

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    correlationId: randomUUID(),
    tenantId: TENANT_ID,
    customerId: `cust-${randomUUID()}`,
    customerIdType: 'MSISDN',
    activityPerformedDate: '2026-09-04T10:15:00.000Z',
    transactionType: null,
    activityCode: 'TXN_TOPUP',
    activityType: 'TOPUP',
    activityCategory: 'TELCO',
    activityValue: '50.0000',
    activityValueUnit: 'MYR',
    channel: 'app',
    activityPerformedEnv: 'production',
    activityName: 'Prepaid Top-up',
    campaignCode: 'CAMP-2026-Q3-001',
    trackerCode: 'TRK-TOPUP-5X',
    trackerComponentCode: 'CMP-TOPUP-STEP-3',
    merchantCode: 'MERCH-001',
    rewardCode: 'RWD-CASHBACK-5PCT',
    rewardCategory: 'CASHBACK',
    rewardValue: '2.5000',
    rewardValueUnit: 'MYR',
    rewardEntryDate: '2026-09-04T10:15:03.000Z',
    completionCycle: 1,
    ...overrides,
  };
}

describe('T-RR-013 — POST /api/v1/reward-entries (real AppModule, real Postgres) (e2e)', () => {
  let app: INestApplication;
  let db: Sequelize;

  beforeAll(async () => {
    if (!TOKEN) {
      throw new Error(
        'REWARD_ENTRY_INGEST_TOKEN is not set — see .env.local (T-RR-013 own header note)',
      );
    }
    db = createMigrationConnection();
    await db.authenticate();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await db.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await db.close();
    await app.close();
  });

  async function countRows(id: string): Promise<number> {
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_redemption.reward_redemption_entry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    return Number(rows[0].count);
  }

  // TC-1
  it('TC-1: a well-formed body with a valid bearer token is accepted and persisted with ingestion_channel = REST', async () => {
    const body = baseBody();

    const response = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rewardEntryId: body.id, status: 'received' });
    expect(await countRows(body.id as string)).toBe(1);

    const rows = await db.query<{ ingestion_channel: string; status: string }>(
      'SELECT ingestion_channel, status FROM reward_redemption.reward_redemption_entry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id: body.id } },
    );
    expect(rows[0].ingestion_channel).toBe('REST');
    expect(rows[0].status).toBe('received');
  });

  // TC-2
  it('TC-2: posting the identical body a second time returns 200 (never 409), no second row', async () => {
    const body = baseBody();

    const first = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body);
    const second = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.rewardEntryId).toBe(body.id);
    // May already have been claimed by T-RR-020's own concurrently-running claim worker on this
    // shared table by the time the second call reads it back — same documented tradeoff
    // `reward-ingest.e2e-spec.ts`'s own TC-2 already accepts. The property this task owns is
    // asserted directly: 200, never 409, and exactly one row for this id.
    expect(['received', 'processing']).toContain(second.body.status);
    expect(await countRows(body.id as string)).toBe(1);
  });

  // TC-3 (negative)
  it('TC-3: no Authorization header — 401, no row inserted', async () => {
    const body = baseBody();

    const response = await request(app.getHttpServer()).post('/api/v1/reward-entries').send(body);

    expect(response.status).toBe(401);
    expect(await countRows(body.id as string)).toBe(0);
  });

  // TC-4 (negative)
  it('TC-4: an incorrect bearer token — 401, no row inserted', async () => {
    const body = baseBody();

    const response = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', 'Bearer not-the-real-token')
      .send(body);

    expect(response.status).toBe(401);
    expect(await countRows(body.id as string)).toBe(0);
  });

  // TC-5 (negative)
  it('TC-5: a body missing campaignCode — 400, descriptive validation error, no row inserted', async () => {
    const { campaignCode: _omit, ...withoutCampaignCode } = baseBody();

    const response = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(withoutCampaignCode);

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/campaignCode/);
    expect(await countRows(withoutCampaignCode.id as string)).toBe(0);
  });

  // TC-6 (negative)
  it('TC-6: an unparseable activityPerformedDate — 400', async () => {
    const body = baseBody({ activityPerformedDate: '2026-09-04 10:15:00' });

    const response = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body);

    expect(response.status).toBe(400);
    expect(await countRows(body.id as string)).toBe(0);
  });

  // TC-7
  it("TC-7: a duplicate id already resolved to status 'failed' returns 200 reporting 'failed'", async () => {
    const body = baseBody();

    const first = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body);
    expect(first.status).toBe(200);

    // Directly forces the existing row to a terminal 'failed' status — standing in for whatever
    // prior test setup drove it there for real (T-RR-020/T-RR-024's own concern, not this task's);
    // this test owns only "the REST leg reports back whatever the row's real status already is."
    await db.query(
      "UPDATE reward_redemption.reward_redemption_entry SET status = 'failed' WHERE id = :id",
      { type: QueryTypes.RAW, replacements: { id: body.id } },
    );

    const second = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body);

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ rewardEntryId: body.id, status: 'failed' });
    expect(await countRows(body.id as string)).toBe(1);
  });
});
