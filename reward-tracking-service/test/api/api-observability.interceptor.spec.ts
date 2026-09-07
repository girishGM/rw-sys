/**
 * T-RTS-050 — `ApiObservabilityInterceptor` and its wiring onto `CustomerRewardsController`/
 * `AdminRewardsController`.
 *
 * Two layers, deliberately: (1) fast, direct unit tests of the interceptor's own resolution logic
 * (correlation id, endpoint label, tenant id, campaign code, error-status mapping, R6 log-field
 * discipline) via a hand-built `ExecutionContext`/`CallHandler`, the same `contextFrom(...)` idiom
 * `test/auth/customer-auth.guard.spec.ts` already uses for guards; and (2) a genuine HTTP-level
 * wiring test per controller (`Test.createTestingModule` + `supertest` + a real `INestApplication`,
 * same convention `test/ingestion/reward-tracking-ingest.controller.spec.ts` (T-RTS-013) already
 * established) with every query/repository dependency faked, so the real `@UseInterceptors(...)`
 * class-level decorator, the real `CustomerAuthGuard`/`PortalAdminAuthGuard`, and this interceptor's
 * real DI wiring are all genuinely exercised — layer (1) alone could never catch "forgot to attach
 * the decorator to the controller", which is the actual defect this task fixes (TC-3).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import {
  BadRequestException,
  ForbiddenException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import request from 'supertest';
import { of, throwError, firstValueFrom } from 'rxjs';
import { ApiObservabilityInterceptor } from '@/modules/api/api-observability.interceptor';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLoggerFactory } from '@/observability/logging.module';
import { CustomerRewardsController } from '@/modules/api/customer-rewards.controller';
import { CustomerRewardLedgerQueryService } from '@/modules/api/customer-reward-ledger-query.service';
import { CustomerRewardBalanceRepository } from '@/modules/api/customer-reward-balance.repository';
import { CustomerIdCryptoService } from '@/modules/ingestion/customer-id-crypto.service';
import { loadCustomerAuthSecret, signCustomerToken } from '@/modules/auth/customer-auth.guard';
import { AdminRewardsController } from '@/modules/api/admin-rewards.controller';
import { CampaignSummaryQueryService } from '@/modules/api/campaign-summary-query.service';
import { CountedLevelQueryService } from '@/modules/api/counted-level-query.service';
import { AlertsQueryService } from '@/modules/api/alerts-query.service';
import {
  loadPortalAdminAuthSecret,
  signPortalAdminToken,
} from '@/modules/auth/portal-admin-auth.guard';

function fakeResponse(): { statusCode: number; setHeader: jest.Mock } {
  return { statusCode: 200, setHeader: jest.fn() };
}

function contextFor(options: {
  request: Record<string, unknown>;
  response: { statusCode: number; setHeader: jest.Mock };
  handler: (...args: unknown[]) => unknown;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => options.request as T,
      getResponse: <T>() => options.response as T,
    }),
    getHandler: () => options.handler,
  } as unknown as ExecutionContext;
}

function handlerReturning(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

function handlerThrowing(error: unknown): CallHandler {
  return { handle: () => throwError(() => error) };
}

// A handler function decorated exactly like `@Get('campaigns/:campaignCode/summary')` would be —
// `Reflect.defineMetadata('path', ..., handler)` is exactly what Nest's own `@Get()` does under the
// hood, so this is the real mechanism, not a stand-in for it.
function handlerWithPath(path: string): (...args: unknown[]) => unknown {
  const fn = (): void => undefined;
  Reflect.defineMetadata('path', path, fn);
  return fn;
}

describe('T-RTS-050 — ApiObservabilityInterceptor (unit)', () => {
  let metrics: MetricsService;
  let interceptor: ApiObservabilityInterceptor;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    metrics = new MetricsService();
    interceptor = new ApiObservabilityInterceptor(metrics, new StructuredLoggerFactory());
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // TC-2 / TC-3 (unit half — see the HTTP-level suite below for the wiring half).
  it('increments reward_tracking_api_requests_total{endpoint,status} exactly once on success', async () => {
    const response = fakeResponse();
    const context = contextFor({
      request: { headers: {}, params: {}, query: {} },
      response,
      handler: handlerWithPath('summary'),
    });

    await firstValueFrom(interceptor.intercept(context, handlerReturning({ ok: true })));

    expect(
      metrics.getCounterValue('reward_tracking_api_requests_total', {
        endpoint: 'summary',
        status: '200',
      }),
    ).toBe(1);
    expect(response.setHeader).toHaveBeenCalledWith('X-Correlation-Id', expect.any(String));

    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged.message).toBe('API request completed');
    expect(logged.endpoint).toBe('summary');
    expect(logged.status).toBe(200);
    expect(logged.correlationId).toEqual(expect.any(String));
  });

  it('honors an inbound X-Correlation-Id header instead of generating a fresh one', async () => {
    const response = fakeResponse();
    const context = contextFor({
      request: { headers: { 'x-correlation-id': 'corr-from-caller' }, params: {}, query: {} },
      response,
      handler: handlerWithPath('summary'),
    });

    await firstValueFrom(interceptor.intercept(context, handlerReturning({})));

    expect(response.setHeader).toHaveBeenCalledWith('X-Correlation-Id', 'corr-from-caller');
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged.correlationId).toBe('corr-from-caller');
  });

  it('generates a distinct correlation id per request when none is supplied', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const response = fakeResponse();
      const context = contextFor({
        request: { headers: {}, params: {}, query: {} },
        response,
        handler: handlerWithPath('summary'),
      });
      await firstValueFrom(interceptor.intercept(context, handlerReturning({})));
      const correlationId = response.setHeader.mock.calls[0][1] as string;
      seen.add(correlationId);
    }
    expect(seen.size).toBe(3);
  });

  // TC-1/TC-3 evidence: a thrown BadRequestException must still increment the metric, with the
  // exception's own status, and must still propagate to the caller unchanged.
  it('increments the metric with status 400 on a thrown BadRequestException, and rethrows it', async () => {
    const response = fakeResponse();
    const context = contextFor({
      request: { headers: {}, params: {}, query: {} },
      response,
      handler: handlerWithPath('expiring'),
    });
    const error = new BadRequestException('withinDays is required');

    await expect(
      firstValueFrom(interceptor.intercept(context, handlerThrowing(error))),
    ).rejects.toBe(error);

    expect(
      metrics.getCounterValue('reward_tracking_api_requests_total', {
        endpoint: 'expiring',
        status: '400',
      }),
    ).toBe(1);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged.message).toBe('API request rejected');
    expect(logged.status).toBe(400);
  });

  it('increments the metric with status 403 on a thrown ForbiddenException', async () => {
    const response = fakeResponse();
    const context = contextFor({
      request: { headers: {}, params: { campaignCode: 'CAMP-1' }, query: {} },
      response,
      handler: handlerWithPath('campaigns/:campaignCode/summary'),
    });
    const error = new ForbiddenException('Token is not authorized for this tenant');

    await expect(
      firstValueFrom(interceptor.intercept(context, handlerThrowing(error))),
    ).rejects.toBe(error);

    expect(
      metrics.getCounterValue('reward_tracking_api_requests_total', {
        endpoint: 'campaigns/:campaignCode/summary',
        status: '403',
      }),
    ).toBe(1);
  });

  it('defaults to status 500 for a thrown error that is not an HttpException, and logs at error level', async () => {
    const response = fakeResponse();
    const context = contextFor({
      request: { headers: {}, params: {}, query: {} },
      response,
      handler: handlerWithPath('summary'),
    });
    const error = new Error('unexpected');

    await expect(
      firstValueFrom(interceptor.intercept(context, handlerThrowing(error))),
    ).rejects.toBe(error);

    expect(
      metrics.getCounterValue('reward_tracking_api_requests_total', {
        endpoint: 'summary',
        status: '500',
      }),
    ).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves tenantId from request.customerAuth on the customer surface', async () => {
    const response = fakeResponse();
    const context = contextFor({
      request: {
        headers: {},
        params: {},
        query: {},
        customerAuth: { tenantId: 777, customerId: 'c-1' },
      },
      response,
      handler: handlerWithPath('summary'),
    });

    await firstValueFrom(interceptor.intercept(context, handlerReturning({})));

    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged.tenantId).toBe(777);
    // R6 — never a literal customerId field, even though the request carries one under a
    // differently-named key this interceptor never reads.
    expect(logged.customerId).toBeUndefined();
  });

  it('resolves tenantId from request.portalAdmin on the admin surface, and campaignCode from params', async () => {
    const response = fakeResponse();
    const context = contextFor({
      request: {
        headers: {},
        params: { campaignCode: 'CAMP-9' },
        query: {},
        portalAdmin: { tenantId: 55, role: 'tenant_admin', countryId: null, merchantId: null },
      },
      response,
      handler: handlerWithPath('campaigns/:campaignCode/summary'),
    });

    await firstValueFrom(interceptor.intercept(context, handlerReturning({})));

    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged.tenantId).toBe(55);
    expect(logged.campaignCode).toBe('CAMP-9');
  });

  it('falls back to a campaignCode query param when there is no route param (customer summary endpoint)', async () => {
    const response = fakeResponse();
    const context = contextFor({
      request: { headers: {}, params: {}, query: { campaignCode: 'CAMP-QS' } },
      response,
      handler: handlerWithPath('summary'),
    });

    await firstValueFrom(interceptor.intercept(context, handlerReturning({})));

    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged.campaignCode).toBe('CAMP-QS');
  });

  it('labels an unknown/undecorated handler as "unknown" rather than throwing', async () => {
    const response = fakeResponse();
    const context = contextFor({
      request: { headers: {}, params: {}, query: {} },
      response,
      handler: (): void => undefined,
    });

    await firstValueFrom(interceptor.intercept(context, handlerReturning({})));

    expect(
      metrics.getCounterValue('reward_tracking_api_requests_total', {
        endpoint: 'unknown',
        status: '200',
      }),
    ).toBe(1);
  });
});

describe('T-RTS-050 — wiring onto CustomerRewardsController (HTTP-level)', () => {
  let app: INestApplication;
  let metrics: MetricsService;
  const secret = loadCustomerAuthSecret();

  beforeEach(async () => {
    const ledgerQuery = {
      findLedgerComponents: jest.fn().mockResolvedValue([]),
      findTrackerTotals: jest.fn().mockResolvedValue([]),
      findCampaignTotals: jest.fn().mockResolvedValue([]),
    };
    const balanceRepository = {
      populateMissing: jest.fn().mockResolvedValue(0),
      findExpiring: jest.fn().mockResolvedValue([]),
    };
    const crypto = { hash: jest.fn().mockReturnValue('hashed') };

    const moduleRef = await Test.createTestingModule({
      controllers: [CustomerRewardsController],
      providers: [
        ApiObservabilityInterceptor,
        MetricsService,
        StructuredLoggerFactory,
        { provide: CustomerRewardLedgerQueryService, useValue: ledgerQuery },
        { provide: CustomerRewardBalanceRepository, useValue: balanceRepository },
        { provide: CustomerIdCryptoService, useValue: crypto },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    metrics = moduleRef.get(MetricsService);
    metrics.resetForTests();
  });

  afterEach(async () => {
    await app.close();
  });

  function bearer(customerId: string): string {
    return `Bearer ${signCustomerToken(
      { tenantId: 1, customerId, exp: Math.floor(Date.now() / 1000) + 3600 },
      secret,
    )}`;
  }

  // TC-3 — this is the test that fails without the fix: with `@UseInterceptors(...)` removed from
  // `CustomerRewardsController` (verified by temporarily commenting it out and rerunning this file:
  // the counter below reads back `0`, not `1`), this assertion catches exactly the reported defect.
  it('TC-3: a successful GET increments reward_tracking_api_requests_total{endpoint:"summary",status:200} and echoes a correlation id', async () => {
    const customerId = `customer-${randomUUID()}`;
    const response = await request(app.getHttpServer())
      .get(`/customers/${customerId}/rewards/summary`)
      .set('Authorization', bearer(customerId))
      .expect(200);

    expect(
      metrics.getCounterValue('reward_tracking_api_requests_total', {
        endpoint: 'summary',
        status: '200',
      }),
    ).toBe(1);
    expect(response.headers['x-correlation-id']).toEqual(expect.any(String));
  });

  it('a handler-thrown BadRequestException still increments the metric with status 400', async () => {
    const customerId = `customer-${randomUUID()}`;
    await request(app.getHttpServer())
      .get(`/customers/${customerId}/rewards/expiring`)
      .set('Authorization', bearer(customerId))
      .expect(400);

    expect(
      metrics.getCounterValue('reward_tracking_api_requests_total', {
        endpoint: 'expiring',
        status: '400',
      }),
    ).toBe(1);
  });

  it('an inbound X-Correlation-Id header is echoed back unchanged', async () => {
    const customerId = `customer-${randomUUID()}`;
    const response = await request(app.getHttpServer())
      .get(`/customers/${customerId}/rewards/summary`)
      .set('Authorization', bearer(customerId))
      .set('X-Correlation-Id', 'caller-supplied-id')
      .expect(200);

    expect(response.headers['x-correlation-id']).toBe('caller-supplied-id');
  });
});

describe('T-RTS-050 — wiring onto AdminRewardsController (HTTP-level)', () => {
  let app: INestApplication;
  let metrics: MetricsService;
  const secret = loadPortalAdminAuthSecret();

  beforeEach(async () => {
    const campaignSummary = {
      resolveTenantAndVerifyCountry: jest.fn(),
      computeCampaignSummary: jest.fn(),
    };
    const countedLevel = {
      findMerchantTotals: jest.fn(),
      findTenantTotals: jest.fn(),
      findCountryTotals: jest.fn(),
      resolveMerchantCodeForId: jest.fn(),
    };
    const alerts = { listAlerts: jest.fn().mockResolvedValue([]) };

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminRewardsController],
      providers: [
        ApiObservabilityInterceptor,
        MetricsService,
        StructuredLoggerFactory,
        { provide: CampaignSummaryQueryService, useValue: campaignSummary },
        { provide: CountedLevelQueryService, useValue: countedLevel },
        { provide: AlertsQueryService, useValue: alerts },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    metrics = moduleRef.get(MetricsService);
    metrics.resetForTests();
  });

  afterEach(async () => {
    await app.close();
  });

  function bearer(): string {
    return `Bearer ${signPortalAdminToken(
      {
        role: 'super_admin',
        countryId: null,
        tenantId: null,
        merchantId: null,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      secret,
    )}`;
  }

  it('TC-3: a successful GET /reward-tracking/alerts increments the metric with endpoint "alerts"', async () => {
    const response = await request(app.getHttpServer())
      .get('/reward-tracking/alerts')
      .set('Authorization', bearer())
      .expect(200);

    expect(
      metrics.getCounterValue('reward_tracking_api_requests_total', {
        endpoint: 'alerts',
        status: '200',
      }),
    ).toBe(1);
    expect(response.headers['x-correlation-id']).toEqual(expect.any(String));
  });

  it('a handler-thrown BadRequestException on a malformed tenantId still increments the metric with status 400', async () => {
    await request(app.getHttpServer())
      .get('/reward-tracking/tenants/not-a-number/summary')
      .set('Authorization', bearer())
      .expect(400);

    expect(
      metrics.getCounterValue('reward_tracking_api_requests_total', {
        endpoint: 'tenants/:tenantId/summary',
        status: '400',
      }),
    ).toBe(1);
  });
});
