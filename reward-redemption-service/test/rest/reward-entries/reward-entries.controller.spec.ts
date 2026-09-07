/**
 * T-RR-013. Fast, mocked-dependency unit tests for `RewardEntriesController` — parsing/mapping/
 * auth behavior against a faked `RewardIngestionService`, plus the static, file-content checks
 * R6/R10 call for (mirroring `test/grpc/reward-ingest.controller.spec.ts`'s own precedent for the
 * gRPC leg). The real round trip against a real `AppModule` + real Postgres (TC-1/TC-2/TC-7) lives
 * in `reward-entries.e2e-spec.ts`.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { RewardEntriesController } from '@/rest/reward-entries/reward-entries.controller';
import { IngestTokenGuard } from '@/rest/reward-entries/ingest-token.guard';
import { RewardIngestionService } from '@/modules/reward-ingestion/reward-ingestion.service';
import type { IngestResult } from '@/modules/reward-ingestion/reward-ingestion.service';
import type { RewardEntryIngestDto } from '@/modules/reward-ingestion/reward-entry-ingest.dto';

const CONTROLLER_SOURCE_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'rest',
  'reward-entries',
  'reward-entries.controller.ts',
);

const TOKEN = 'unit-test-reward-entry-ingest-token';

const receivedResult: IngestResult = { rewardEntryId: 'reward-entry-1', status: 'received' };

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'reward-entry-1',
    correlationId: 'corr-1',
    tenantId: 1,
    customerId: 'MSISDN-60123456789',
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

describe('T-RR-013 — POST /api/v1/reward-entries (controller, faked domain service)', () => {
  let app: INestApplication;
  let ingest: jest.Mock;

  beforeEach(async () => {
    process.env.REWARD_ENTRY_INGEST_TOKEN = TOKEN;
    ingest = jest.fn().mockResolvedValue(receivedResult);
    const moduleRef = await Test.createTestingModule({
      controllers: [RewardEntriesController],
      providers: [IngestTokenGuard, { provide: RewardIngestionService, useValue: { ingest } }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  // TC-1
  it('TC-1: a well-formed body with a valid bearer token maps to RewardEntryIngestDto, calls ingest(), returns 200', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(validBody());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rewardEntryId: 'reward-entry-1', status: 'received' });
    expect(ingest).toHaveBeenCalledTimes(1);
    const [[dto]] = ingest.mock.calls as [[RewardEntryIngestDto]];
    expect(dto.ingestionChannel).toBe('REST');
    expect(dto.id).toBe('reward-entry-1');
    expect(dto.campaignCode).toBe('CAMP-2026-Q3-001');
    expect(dto.activityPerformedDate).toBeInstanceOf(Date);
    expect(dto.activityPerformedDate.toISOString()).toBe('2026-09-04T10:15:00.000Z');
    expect(dto.rewardEntryDate).toBeInstanceOf(Date);
  });

  // TC-2: duplicate handling itself is T-RR-010's own concern — this proves the controller reports
  // whatever `ingest()` returns verbatim, never branching into a different (e.g. 409) response.
  it('TC-2: a duplicate-arrival IngestResult maps straight through as 200, never 409', async () => {
    ingest.mockResolvedValue({ rewardEntryId: 'reward-entry-1', status: 'processing' });

    const response = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(validBody());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rewardEntryId: 'reward-entry-1', status: 'processing' });
  });

  // TC-7
  it("TC-7: an already-failed duplicate's status maps straight through unchanged", async () => {
    ingest.mockResolvedValue({ rewardEntryId: 'reward-entry-1', status: 'failed' });

    const response = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(validBody());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rewardEntryId: 'reward-entry-1', status: 'failed' });
  });

  // TC-3 (negative)
  it('TC-3: no Authorization header — 401, ingest() never called', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .send(validBody());

    expect(response.status).toBe(401);
    expect(ingest).not.toHaveBeenCalled();
  });

  // TC-4 (negative)
  it("TC-4: an incorrect bearer token (e.g. another guard's token) — 401, ingest() never called", async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', 'Bearer some-other-service-token')
      .send(validBody());

    expect(response.status).toBe(401);
    expect(ingest).not.toHaveBeenCalled();
  });

  // TC-5 (negative)
  it('TC-5: missing campaignCode — 400, descriptive error, ingest() never called', async () => {
    const { campaignCode: _omit, ...withoutCampaignCode } = validBody();

    const response = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(withoutCampaignCode);

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/campaignCode/);
    expect(ingest).not.toHaveBeenCalled();
  });

  // TC-6 (negative)
  it('TC-6: an unparseable activityPerformedDate — 400, ingest() never called', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(validBody({ activityPerformedDate: '2026-09-04 10:15:00' }));

    expect(response.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rejects a non-decimal activityValue with 400, ingest() never called', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(validBody({ activityValue: 'not-a-number' }));

    expect(response.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rejects a body missing both transactionType and activityCode with 400', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(validBody({ transactionType: null, activityCode: null }));

    expect(response.status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('accepts a transactionType-only body (no activityCode)', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(validBody({ activityCode: null, transactionType: 'TXN_PURCHASE' }));

    expect(response.status).toBe(200);
    const [[dto]] = ingest.mock.calls as [[RewardEntryIngestDto]];
    expect(dto.transactionType).toBe('TXN_PURCHASE');
    expect(dto.activityCode).toBeNull();
  });

  it('GET is rejected, never silently treated as POST', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/reward-entries');
    expect([404, 405]).toContain(response.status);
  });
});

describe('T-RR-013 — R6/R10 code-inspection guard (no 409, no business logic in a transport adapter)', () => {
  const controllerSource = readFileSync(CONTROLLER_SOURCE_PATH, 'utf8');

  it('never returns 409 Conflict anywhere in this controller (R6, implementation note 2)', () => {
    expect(controllerSource).not.toContain('409');
  });

  it('the controller never references persistence/encryption/repository internals of its own (R10)', () => {
    const forbiddenSymbols = [
      'RewardRedemptionEntryRepository',
      'EncryptionService',
      'LogRedactorService',
      'ON CONFLICT',
      'pg.Pool',
      'new Pool(',
    ];
    for (const symbol of forbiddenSymbols) {
      expect(controllerSource).not.toContain(symbol);
    }
  });

  it('the controller only ever calls ingest() on the injected service, never re-implements it', () => {
    const ingestCallSites = controllerSource.match(/this\.ingestionService\.ingest\(/g) ?? [];
    expect(ingestCallSites).toHaveLength(1);
  });
});
