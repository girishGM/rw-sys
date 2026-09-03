/**
 * T-RAP-043. Unit tests for `StructuredLogger`/`StructuredLoggerFactory` — `LogRedactorService` is
 * a hand-rolled fake (same convention `activity-ingestion.service.spec.ts` already established for
 * this exact collaborator), no DB, no Nest test module. `console.*` is spied on rather than
 * replaced, so every assertion below reads the actual line this class would emit.
 */
import type { LogRedactorService } from '@/modules/encryption/log-redactor.service';
import {
  StructuredLogger,
  StructuredLoggerFactory,
  type StructuredLogFields,
} from '@/observability/structured-logger';

function fakeRedactor(): LogRedactorService {
  return {
    resolve: jest.fn(() => false),
    redact: jest.fn((field: string) => `[REDACTED:${field}]`),
  } as unknown as LogRedactorService;
}

describe('StructuredLogger', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function loggedEntry(spy: jest.SpyInstance): Record<string, unknown> {
    expect(spy).toHaveBeenCalledTimes(1);
    return JSON.parse(spy.mock.calls[0][0] as string);
  }

  // TC-2 (mechanism): correlationId/tenantId/campaignCode are separate, machine-readable fields —
  // never string-interpolated into `message`.
  it('emits correlationId/tenantId/campaignCode as separate JSON fields, not interpolated into the message', () => {
    const logger = new StructuredLogger('SomeService', fakeRedactor());

    logger.log('activity received', {
      correlationId: 'corr-1',
      tenantId: 7,
      campaignCode: 'CAMP1',
    });

    const entry = loggedEntry(logSpy);
    expect(entry.message).toBe('activity received');
    expect(entry.correlationId).toBe('corr-1');
    expect(entry.tenantId).toBe(7);
    expect(entry.campaignCode).toBe('CAMP1');
    // The message string itself never contains the field values baked in — proves they were
    // attached structurally, not string-interpolated.
    expect(String(entry.message)).not.toContain('corr-1');
    expect(String(entry.message)).not.toContain('CAMP1');
  });

  it('attaches context, level and an ISO timestamp on every entry', () => {
    const logger = new StructuredLogger('BudgetService', fakeRedactor());
    logger.warn('cap breached', { correlationId: 'corr-2' });

    const entry = loggedEntry(warnSpy);
    expect(entry.context).toBe('BudgetService');
    expect(entry.level).toBe('warn');
    expect(typeof entry.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(entry.timestamp as string))).toBe(false);
  });

  it('routes log/debug/warn/error to their own console method', () => {
    const logger = new StructuredLogger('X', fakeRedactor());
    const fields: StructuredLogFields = { correlationId: 'corr-3' };

    logger.log('a', fields);
    logger.debug('b', fields);
    logger.warn('c', fields);
    logger.error('d', fields);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  // 06-CONFIGURABILITY-AND-OBSERVABILITY.md §1: correlationId is never redacted, and this class
  // never runs it through the redactor at all.
  it('never runs correlationId through the redactor', () => {
    const redactor = fakeRedactor();
    const logger = new StructuredLogger('X', redactor);

    logger.log('receipt', { correlationId: 'corr-plaintext-visible' });

    expect(redactor.redact).not.toHaveBeenCalled();
    const entry = loggedEntry(logSpy);
    expect(entry.correlationId).toBe('corr-plaintext-visible');
  });

  it('throws rather than silently logging when correlationId is missing or blank', () => {
    const logger = new StructuredLogger('X', fakeRedactor());

    expect(() => logger.log('no id', {} as StructuredLogFields)).toThrow(/correlationId/);
    expect(() => logger.log('blank id', { correlationId: '   ' })).toThrow(/correlationId/);
    expect(logSpy).not.toHaveBeenCalled();
  });

  // TC-4 regression: a field the caller redacts via `redactField` before logging carries the
  // placeholder, never the real value, in the emitted line.
  it('redactField proxies LogRedactorService.redact, so a redacted field never reaches the log line unredacted', () => {
    const redactor = fakeRedactor();
    const logger = new StructuredLogger('ActivityIngestionService', redactor);

    const redactedValue = logger.redactField('customerId', 'CUST-PLAINTEXT-00042', {
      tenantId: 7,
    });
    logger.log('activity received', { correlationId: 'corr-4', customerId: redactedValue });

    expect(redactor.redact).toHaveBeenCalledWith('customerId', 'CUST-PLAINTEXT-00042', {
      tenantId: 7,
    });
    const entry = loggedEntry(logSpy);
    expect(entry.customerId).toBe('[REDACTED:customerId]');
    expect(JSON.stringify(entry)).not.toContain('CUST-PLAINTEXT-00042');
  });

  // TC-2: a full pipeline run's log lines all share one correlationId and appear in call order.
  it('a sequence of calls across multiple logger instances stays correlated by one shared correlationId, in order', () => {
    const redactor = fakeRedactor();
    const correlationId = 'corr-pipeline-1';

    const ingestionLogger = new StructuredLogger('ActivityIngestionService', redactor);
    const processingLogger = new StructuredLogger('RuleEvaluationRowHandler', redactor);
    const dispatchLogger = new StructuredLogger('OutboxPublisherService', redactor);

    ingestionLogger.log('activity received', { correlationId, tenantId: 7, campaignCode: 'CAMP1' });
    processingLogger.log('component completed', {
      correlationId,
      tenantId: 7,
      campaignCode: 'CAMP1',
    });
    dispatchLogger.log('reward dispatched', {
      correlationId,
      tenantId: 7,
      campaignCode: 'CAMP1',
    });

    expect(logSpy).toHaveBeenCalledTimes(3);
    const entries = logSpy.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(entries.every((entry) => entry.correlationId === correlationId)).toBe(true);
    expect(entries.map((entry) => entry.context)).toEqual([
      'ActivityIngestionService',
      'RuleEvaluationRowHandler',
      'OutboxPublisherService',
    ]);
    expect(entries.map((entry) => entry.message)).toEqual([
      'activity received',
      'component completed',
      'reward dispatched',
    ]);
  });

  it('base structural fields (timestamp/level/context/message) always win over a same-named field the caller passes in', () => {
    const logger = new StructuredLogger('RealContext', fakeRedactor());

    logger.log('real message', {
      correlationId: 'corr-5',
      // A caller could accidentally name an extra field the same as a structural one.
      context: 'attacker-supplied-context',
      level: 'error',
      message: 'attacker-supplied-message',
    } as unknown as StructuredLogFields);

    const entry = loggedEntry(logSpy);
    expect(entry.context).toBe('RealContext');
    expect(entry.level).toBe('log');
    expect(entry.message).toBe('real message');
  });
});

describe('StructuredLoggerFactory', () => {
  it('forContext returns a StructuredLogger bound to that context, sharing this factory’s LogRedactorService', () => {
    const redactor = fakeRedactor();
    const factory = new StructuredLoggerFactory(redactor);

    const logger = factory.forContext('MyService');
    expect(logger).toBeInstanceOf(StructuredLogger);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    logger.log('hello', { correlationId: 'corr-6' });
    const entry = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(entry.context).toBe('MyService');
    logSpy.mockRestore();
  });
});
