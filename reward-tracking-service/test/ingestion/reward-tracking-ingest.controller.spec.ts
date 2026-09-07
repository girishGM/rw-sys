/**
 * T-RTS-013 — fast, mocked-dependency unit tests for `RewardTrackingIngestController` — parsing/
 * mapping/auth behavior against a faked `RewardTrackingIngestionService`, exercised over a real
 * `INestApplication` (`Test.createTestingModule` + `supertest`) so the guard/pipe/HTTP-status wiring
 * is genuinely exercised, not just the class's own methods called directly — same "assert the
 * observable property" discipline `reward-redemption-service`'s own
 * `reward-entries.controller.spec.ts` (T-RR-013, confirmed by direct read) already established for
 * the identical situation. No real Postgres/AppModule here — this task's own "Files owned" list
 * names exactly one spec file, and `RewardTrackingIngestionService`'s own real-transaction behavior
 * is already proven by `reward-tracking-ingestion.service.spec.ts` (T-RTS-010); this file only
 * proves the adapter is a thin, correct pass-through (R8).
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  MissingRewardTrackingIngestTokenError,
  RewardTrackingIngestController,
  RewardTrackingIngestTokenGuard,
} from '@/modules/ingestion/reward-tracking-ingest.controller';
import { RewardTrackingIngestionService } from '@/modules/ingestion/reward-tracking-ingestion.service';
import type {
  ApplyRewardTrackingEventInput,
  ApplyRewardTrackingEventResult,
} from '@/modules/ingestion/reward-tracking-ingestion.service';
import type { RewardFactRow } from '@/database/models/reward-fact.model';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLoggerFactory } from '@/observability/logging.module';

const TOKEN = 'unit-test-reward-tracking-ingest-token';
const ENV_KEY = 'REWARD_TRACKING_INGEST_TOKEN';

const rewardFact: RewardFactRow = {
  id: 'fact-1',
  reward_entry_id: 'reward-entry-1',
  correlation_id: 'corr-1',
  tenant_id: 1,
  tenant_code: 'T1',
  country_code: 'US',
  customer_id_encrypted: 'encrypted',
  customer_id_hash: 'hash',
  campaign_code: 'CAMP-1',
  tracker_code: 'TRK-1',
  tracker_component_code: 'CMP-1',
  merchant_code: null,
  reward_code: 'RWD-1',
  reward_category: 'CASHBACK',
  reward_kind: 'FIXED_AMOUNT',
  unit_type: 'CURRENCY',
  unit_code: 'USD',
  reward_value: '5.00',
  reward_value_unit: 'USD',
  external_system_code: null,
  external_reference_id: null,
  promo_code_config_id: null,
  promo_code_config_version_no: null,
  redeemed_at: new Date('2026-09-04T10:15:00.000Z'),
  expires_at: null,
  reward_lifecycle_status: 'ACTIVE',
  ingested_at: new Date('2026-09-04T10:15:01.000Z'),
  created_at: new Date('2026-09-04T10:15:01.000Z'),
};

const appliedResult: ApplyRewardTrackingEventResult = {
  rewardEntryId: 'reward-entry-1',
  status: 'applied',
  rewardFact,
};

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rewardEntryId: 'reward-entry-1',
    correlationId: 'corr-1',
    tenantId: 1,
    tenantCode: 'T1',
    countryCode: 'US',
    customerId: 'customer-1',
    campaignCode: 'CAMP-1',
    trackerCode: 'TRK-1',
    trackerComponentCode: 'CMP-1',
    merchantCode: null,
    rewardCode: 'RWD-1',
    rewardCategory: 'CASHBACK',
    rewardKind: 'FIXED_AMOUNT',
    unitType: 'CURRENCY',
    unitCode: 'USD',
    rewardValue: '5.00',
    rewardValueUnit: 'USD',
    externalSystemCode: null,
    externalReferenceId: null,
    promoCodeConfigId: null,
    promoCodeConfigVersionNo: null,
    redeemedAt: '2026-09-04T10:15:00.000Z',
    expiresAt: null,
    ...overrides,
  };
}

describe('T-RTS-013 — POST /internal/reward-tracking-events (controller, faked domain service)', () => {
  let app: INestApplication;
  let applyRewardTrackingEvent: jest.Mock;
  let savedToken: string | undefined;
  let metrics: MetricsService;

  beforeEach(async () => {
    savedToken = process.env[ENV_KEY];
    process.env[ENV_KEY] = TOKEN;
    applyRewardTrackingEvent = jest.fn().mockResolvedValue(appliedResult);
    metrics = new MetricsService();
    const moduleRef = await Test.createTestingModule({
      controllers: [RewardTrackingIngestController],
      providers: [
        RewardTrackingIngestTokenGuard,
        { provide: RewardTrackingIngestionService, useValue: { applyRewardTrackingEvent } },
        { provide: MetricsService, useValue: metrics },
        StructuredLoggerFactory,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    if (savedToken === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedToken;
  });

  // TC-1
  it("TC-1: a valid POST with a correct token maps to ApplyRewardTrackingEventInput, calls the service, returns 200 {status: 'applied'}", async () => {
    const response = await request(app.getHttpServer())
      .post('/internal/reward-tracking-events')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(validBody());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'applied' });
    expect(applyRewardTrackingEvent).toHaveBeenCalledTimes(1);
    const [[input]] = applyRewardTrackingEvent.mock.calls as [[ApplyRewardTrackingEventInput]];
    expect(input.receivedChannel).toBe('REST');
    expect(input.rewardEntryId).toBe('reward-entry-1');
    expect(input.campaignCode).toBe('CAMP-1');
    expect(input.redeemedAt).toBeInstanceOf(Date);
    expect(input.redeemedAt.toISOString()).toBe('2026-09-04T10:15:00.000Z');
  });

  // TC-2 — the controller reports whatever the service returns verbatim.
  it("TC-2: the identical POST repeated returns 200 {status: 'duplicate'} once the faked service reports it, and never a different shape", async () => {
    applyRewardTrackingEvent.mockResolvedValue({ ...appliedResult, status: 'duplicate' });

    const response = await request(app.getHttpServer())
      .post('/internal/reward-tracking-events')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(validBody());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'duplicate' });
  });

  // TC-3 (missing token)
  it('TC-3a: no Authorization header — 401, the domain service is never called', async () => {
    const response = await request(app.getHttpServer())
      .post('/internal/reward-tracking-events')
      .send(validBody());

    expect(response.status).toBe(401);
    expect(applyRewardTrackingEvent).not.toHaveBeenCalled();
  });

  // TC-3 (wrong token)
  it('TC-3b: an incorrect bearer token — 401, the domain service is never called', async () => {
    const response = await request(app.getHttpServer())
      .post('/internal/reward-tracking-events')
      .set('Authorization', 'Bearer some-other-token')
      .send(validBody());

    expect(response.status).toBe(401);
    expect(applyRewardTrackingEvent).not.toHaveBeenCalled();
  });

  // TC-4
  it('TC-4a: a malformed body (missing campaignCode) — 400, the domain service is never called', async () => {
    const { campaignCode: _omit, ...withoutCampaignCode } = validBody();

    const response = await request(app.getHttpServer())
      .post('/internal/reward-tracking-events')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(withoutCampaignCode);

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/campaignCode/);
    expect(applyRewardTrackingEvent).not.toHaveBeenCalled();
  });

  it('TC-4b: a non-numeric rewardValue — 400, the domain service is never called', async () => {
    const response = await request(app.getHttpServer())
      .post('/internal/reward-tracking-events')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(validBody({ rewardValue: 'not-a-number' }));

    expect(response.status).toBe(400);
    expect(applyRewardTrackingEvent).not.toHaveBeenCalled();
  });

  it('TC-4c: an unparseable redeemedAt — 400, the domain service is never called', async () => {
    const response = await request(app.getHttpServer())
      .post('/internal/reward-tracking-events')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(validBody({ redeemedAt: 'not-a-date' }));

    expect(response.status).toBe(400);
    expect(applyRewardTrackingEvent).not.toHaveBeenCalled();
  });

  it('TC-4d: a non-object body — 400, the domain service is never called', async () => {
    const response = await request(app.getHttpServer())
      .post('/internal/reward-tracking-events')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Content-Type', 'application/json')
      .send('"just a string"');

    expect(response.status).toBe(400);
    expect(applyRewardTrackingEvent).not.toHaveBeenCalled();
  });

  it('accepts an optional field explicitly null without rejecting the request', async () => {
    const response = await request(app.getHttpServer())
      .post('/internal/reward-tracking-events')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(validBody({ merchantCode: null, expiresAt: null }));

    expect(response.status).toBe(200);
    const [[input]] = applyRewardTrackingEvent.mock.calls as [[ApplyRewardTrackingEventInput]];
    expect(input.merchantCode).toBeNull();
    expect(input.expiresAt).toBeNull();
  });

  it('GET is rejected, never silently treated as POST', async () => {
    const response = await request(app.getHttpServer()).get('/internal/reward-tracking-events');
    expect([404, 405]).toContain(response.status);
  });

  // T-RTS-049 — defect regression: this channel's own error path never reaches
  // `applyRewardTrackingEvent()`'s own success-path increment (T-RTS-010), so a body-validation
  // failure — a real, distinct ingestion outcome — went completely unmetered/unlogged before this
  // fix. Proven red against the pre-fix code (see this task's own completion report) before this
  // fix landed.
  describe('T-RTS-049 — observability wiring', () => {
    it("TC-2/TC-3: a body-validation failure (never reaching the domain method) increments outcome:'failed' and logs correlationId", async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const { campaignCode: _omit, ...withoutCampaignCode } = validBody();
        const before = metrics.getCounterValue('reward_tracking_events_ingested_total', {
          channel: 'REST',
          outcome: 'failed',
        });

        const response = await request(app.getHttpServer())
          .post('/internal/reward-tracking-events')
          .set('Authorization', `Bearer ${TOKEN}`)
          .send(withoutCampaignCode);

        expect(response.status).toBe(400);
        expect(
          metrics.getCounterValue('reward_tracking_events_ingested_total', {
            channel: 'REST',
            outcome: 'failed',
          }),
        ).toBe(before + 1);

        const entries = errorSpy.mock.calls
          .map(([line]) => JSON.parse(line as string) as Record<string, unknown>)
          .filter((entry) => entry.context === 'RewardTrackingIngestController');
        expect(entries).toHaveLength(1);
        expect(entries[0].correlationId).toBe(withoutCampaignCode.correlationId);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("TC-2/TC-3: a genuine applyRewardTrackingEvent() failure also increments outcome:'failed' (not left unmetered)", async () => {
      applyRewardTrackingEvent.mockRejectedValue(new Error('simulated DB outage'));
      const before = metrics.getCounterValue('reward_tracking_events_ingested_total', {
        channel: 'REST',
        outcome: 'failed',
      });

      const response = await request(app.getHttpServer())
        .post('/internal/reward-tracking-events')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send(validBody());

      expect(response.status).toBe(500);
      expect(
        metrics.getCounterValue('reward_tracking_events_ingested_total', {
          channel: 'REST',
          outcome: 'failed',
        }),
      ).toBe(before + 1);
    });

    it('TC-4: customerId never appears in the error-path log line', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        applyRewardTrackingEvent.mockRejectedValue(new Error('simulated DB outage'));
        const body = validBody();

        await request(app.getHttpServer())
          .post('/internal/reward-tracking-events')
          .set('Authorization', `Bearer ${TOKEN}`)
          .send(body);

        const allLogText = errorSpy.mock.calls.map((args) => JSON.stringify(args)).join('\n');
        expect(allLogText).not.toContain(body.customerId as string);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});

describe('T-RTS-013 — RewardTrackingIngestTokenGuard construction', () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedToken;
  });

  it('throws MissingRewardTrackingIngestTokenError when the env var is missing at construction time', () => {
    delete process.env[ENV_KEY];
    expect(() => new RewardTrackingIngestTokenGuard()).toThrow(
      MissingRewardTrackingIngestTokenError,
    );
  });

  it('throws when the env var is present but blank', () => {
    process.env[ENV_KEY] = '   ';
    expect(() => new RewardTrackingIngestTokenGuard()).toThrow(
      MissingRewardTrackingIngestTokenError,
    );
  });
});
