/**
 * T-RTS-040 — `MetricsService`, `StructuredLogger`/`StructuredLoggerFactory`, `LoggingModule`. See
 * `src/observability/metrics.service.ts` and `src/observability/logging.module.ts`'s own headers
 * for why this task's scope stops at "the primitives, fully tested" rather than real call-site
 * wiring (out of this task's own file scope, R10 — see this task's completion report for the
 * defects filed against the owning agents).
 */
import { Test } from '@nestjs/testing';
import { MetricsService } from '@/observability/metrics.service';
import {
  LoggingModule,
  StructuredLogger,
  StructuredLoggerFactory,
} from '@/observability/logging.module';

describe('T-RTS-040 — MetricsService', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  // TC-1: ingest one event per channel — each channel's counter increments correctly.
  it('TC-1: increments reward_tracking_events_ingested_total independently per channel', () => {
    metrics.incrementEventsIngested('GRPC', 'applied');
    metrics.incrementEventsIngested('KAFKA', 'applied');
    metrics.incrementEventsIngested('REST', 'applied');

    expect(
      metrics.getCounterValue('reward_tracking_events_ingested_total', {
        channel: 'GRPC',
        outcome: 'applied',
      }),
    ).toBe(1);
    expect(
      metrics.getCounterValue('reward_tracking_events_ingested_total', {
        channel: 'KAFKA',
        outcome: 'applied',
      }),
    ).toBe(1);
    expect(
      metrics.getCounterValue('reward_tracking_events_ingested_total', {
        channel: 'REST',
        outcome: 'applied',
      }),
    ).toBe(1);
  });

  it('a second event on the same channel accumulates rather than resetting', () => {
    metrics.incrementEventsIngested('GRPC', 'applied');
    metrics.incrementEventsIngested('GRPC', 'applied');

    expect(
      metrics.getCounterValue('reward_tracking_events_ingested_total', {
        channel: 'GRPC',
        outcome: 'applied',
      }),
    ).toBe(2);
  });

  // TC-2: a duplicate ingestion — outcome=duplicate increments, not outcome=applied.
  it('TC-2: a duplicate ingestion increments outcome=duplicate, never outcome=applied', () => {
    metrics.incrementEventsIngested('KAFKA', 'duplicate');

    expect(
      metrics.getCounterValue('reward_tracking_events_ingested_total', {
        channel: 'KAFKA',
        outcome: 'duplicate',
      }),
    ).toBe(1);
    expect(
      metrics.getCounterValue('reward_tracking_events_ingested_total', {
        channel: 'KAFKA',
        outcome: 'applied',
      }),
    ).toBe(0);
  });

  it('a failed ingestion increments outcome=failed only', () => {
    metrics.incrementEventsIngested('REST', 'failed');

    expect(
      metrics.getCounterValue('reward_tracking_events_ingested_total', {
        channel: 'REST',
        outcome: 'failed',
      }),
    ).toBe(1);
    expect(
      metrics.getCounterValue('reward_tracking_events_ingested_total', {
        channel: 'REST',
        outcome: 'applied',
      }),
    ).toBe(0);
    expect(
      metrics.getCounterValue('reward_tracking_events_ingested_total', {
        channel: 'REST',
        outcome: 'duplicate',
      }),
    ).toBe(0);
  });

  it('reward_tracking_shard_write_total is keyed independently per campaign_code', () => {
    metrics.incrementShardWrite('SUMMER25');
    metrics.incrementShardWrite('SUMMER25');
    metrics.incrementShardWrite('WINTER25');

    expect(
      metrics.getCounterValue('reward_tracking_shard_write_total', {
        campaign_code: 'SUMMER25',
      }),
    ).toBe(2);
    expect(
      metrics.getCounterValue('reward_tracking_shard_write_total', {
        campaign_code: 'WINTER25',
      }),
    ).toBe(1);
  });

  it('reward_tracking_api_requests_total is keyed independently per endpoint+status', () => {
    metrics.incrementApiRequest('/api/v1/customers/:customerId/summary', 200);
    metrics.incrementApiRequest('/api/v1/customers/:customerId/summary', 200);
    metrics.incrementApiRequest('/api/v1/customers/:customerId/summary', 404);
    metrics.incrementApiRequest('/api/v1/admin/campaigns/:campaignCode/summary', 200);

    expect(
      metrics.getCounterValue('reward_tracking_api_requests_total', {
        endpoint: '/api/v1/customers/:customerId/summary',
        status: '200',
      }),
    ).toBe(2);
    expect(
      metrics.getCounterValue('reward_tracking_api_requests_total', {
        endpoint: '/api/v1/customers/:customerId/summary',
        status: '404',
      }),
    ).toBe(1);
    expect(
      metrics.getCounterValue('reward_tracking_api_requests_total', {
        endpoint: '/api/v1/admin/campaigns/:campaignCode/summary',
        status: '200',
      }),
    ).toBe(1);
  });

  it('an unincremented counter/label combination reads as 0, never undefined', () => {
    expect(
      metrics.getCounterValue('reward_tracking_events_ingested_total', {
        channel: 'GRPC',
        outcome: 'applied',
      }),
    ).toBe(0);
  });

  it('resetForTests clears every counter back to 0', () => {
    metrics.incrementEventsIngested('GRPC', 'applied');
    metrics.incrementShardWrite('SUMMER25');

    metrics.resetForTests();

    expect(
      metrics.getCounterValue('reward_tracking_events_ingested_total', {
        channel: 'GRPC',
        outcome: 'applied',
      }),
    ).toBe(0);
    expect(
      metrics.getCounterValue('reward_tracking_shard_write_total', { campaign_code: 'SUMMER25' }),
    ).toBe(0);
  });
});

describe('T-RTS-040 — StructuredLogger / StructuredLoggerFactory / LoggingModule', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('emits one JSON line per call with correlationId as a separate structured field, never string-interpolated into the message', () => {
    const logger = new StructuredLogger('SomeService');

    logger.log('reward tracking event ingested', {
      correlationId: 'corr-abc-123',
      campaignCode: 'SUMMER25',
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).not.toContain('corr-abc-123 reward tracking event ingested');
    const parsed = JSON.parse(line);
    expect(parsed.correlationId).toBe('corr-abc-123');
    expect(parsed.campaignCode).toBe('SUMMER25');
    expect(parsed.message).toBe('reward tracking event ingested');
    expect(parsed.level).toBe('log');
    expect(parsed.context).toBe('SomeService');
    expect(typeof parsed.timestamp).toBe('string');
  });

  it('throws when correlationId is missing or blank — never silently omits it', () => {
    const logger = new StructuredLogger('SomeService');

    expect(() => logger.log('x', { correlationId: '' as unknown as string })).toThrow(
      /correlationId/,
    );
    expect(() =>
      // @ts-expect-error T-RTS-040: deliberately omitting the required field to prove the guard fires.
      logger.log('x', {}),
    ).toThrow(/correlationId/);
  });

  // TC-3: no plaintext customerId appears anywhere in a log line, even if a caller passes one by
  // mistake — the primitive-level half of this task's TC-3 (real end-to-end call-site coverage is
  // out of this task's own file scope; see this task's completion report for the filed defects).
  it('TC-3: redacts a raw customerId field before the log line is ever emitted', () => {
    const logger = new StructuredLogger('SomeService');
    const plaintextCustomerId = 'customer-plaintext-98765';

    logger.log('reward tracking event ingested', {
      correlationId: 'corr-abc-123',
      customerId: plaintextCustomerId,
    } as unknown as Parameters<StructuredLogger['log']>[1]);

    const line = logSpy.mock.calls[0][0] as string;
    expect(line).not.toContain(plaintextCustomerId);
    const parsed = JSON.parse(line);
    expect(parsed.customerId).toBe('[REDACTED]');
  });

  it('TC-3: also redacts a snake_case customer_id field', () => {
    const logger = new StructuredLogger('SomeService');
    const plaintextCustomerId = 'customer-plaintext-55555';

    logger.log('x', {
      correlationId: 'corr-1',
      customer_id: plaintextCustomerId,
    } as unknown as Parameters<StructuredLogger['log']>[1]);

    const line = logSpy.mock.calls[0][0] as string;
    expect(line).not.toContain(plaintextCustomerId);
  });

  it('never redacts correlationId itself — the whole point of tracing', () => {
    const logger = new StructuredLogger('SomeService');

    logger.error('failure', { correlationId: 'corr-keep-me' });

    const line = errorSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.correlationId).toBe('corr-keep-me');
  });

  it('a customerIdHash field (already hashed, R6-safe) passes through untouched', () => {
    const logger = new StructuredLogger('SomeService');

    logger.log('x', { correlationId: 'corr-1', customerIdHash: 'abcd1234hash' });

    const line = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.customerIdHash).toBe('abcd1234hash');
  });

  it('warn()/error()/debug() route to their respective console methods', () => {
    const logger = new StructuredLogger('SomeService');
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);

    logger.warn('w', { correlationId: 'corr-1' });
    logger.error('e', { correlationId: 'corr-1' });
    logger.debug('d', { correlationId: 'corr-1' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    debugSpy.mockRestore();
  });

  it('StructuredLoggerFactory.forContext() returns an independently-usable StructuredLogger', () => {
    const factory = new StructuredLoggerFactory();
    const logger = factory.forContext('MyClass');

    logger.log('hello', { correlationId: 'corr-1' });

    const line = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.context).toBe('MyClass');
  });

  it('LoggingModule provides and exports both MetricsService and StructuredLoggerFactory for a consumer to import directly', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [LoggingModule],
    }).compile();

    expect(moduleRef.get(MetricsService)).toBeInstanceOf(MetricsService);
    expect(moduleRef.get(StructuredLoggerFactory)).toBeInstanceOf(StructuredLoggerFactory);
  });
});
