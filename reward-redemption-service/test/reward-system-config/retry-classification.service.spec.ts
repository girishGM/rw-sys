/**
 * T-RR-023 — `RetryClassificationService` (R7). Uses promo-code-service's own real error codes
 * (`CONFIG_NOT_BOUND`, `GENERATION_EXHAUSTED` — `05-PROCESSING-PIPELINE.md` §5) purely as this
 * task's own worked-example *test fixture*, never as a value baked into production code (TC-10,
 * verified separately by the `grep` in this task's completion report/verification step 2).
 */
import type { RetryClassificationConfig } from '@/modules/reward-system-config/retry-classification.service';
import { RetryClassificationService } from '@/modules/reward-system-config/retry-classification.service';

function buildConfig(
  overrides: Partial<RetryClassificationConfig> = {},
): RetryClassificationConfig {
  return {
    retryableErrorCodes: ['GENERATION_EXHAUSTED'],
    retryBackoffBaseMs: 500,
    retryBackoffMaxMs: 30000,
    ...overrides,
  };
}

describe('T-RR-023 — RetryClassificationService', () => {
  let service: RetryClassificationService;

  beforeEach(() => {
    service = new RetryClassificationService();
  });

  it('classifies a SUCCESS outcome as SUCCESS', () => {
    const result = service.classify({ kind: 'SUCCESS' }, buildConfig(), 1);
    expect(result).toEqual({ outcome: 'SUCCESS' });
  });

  // TC-4.
  it('TC-4: classifies a transport timeout with no connector override as RETRYABLE_FAILURE', () => {
    const result = service.classify(
      { kind: 'TRANSPORT_FAILURE', errorCode: 'ETIMEDOUT' },
      buildConfig(),
      1,
    );
    expect(result.outcome).toBe('RETRYABLE_FAILURE');
  });

  // TC-5.
  it('TC-5: classifies a 401 transport-level response as PERMANENT_FAILURE when the connector flags isPermanent', () => {
    const result = service.classify(
      {
        kind: 'TRANSPORT_FAILURE',
        errorCode: '401',
        isPermanent: true,
        errorMessage: 'Unauthorized',
      },
      buildConfig(),
      1,
    );
    expect(result).toEqual({ outcome: 'PERMANENT_FAILURE', reason: 'Unauthorized' });
  });

  // TC-6.
  it('TC-6: classifies an in-body GENERATION_EXHAUSTED error as RETRYABLE_FAILURE when it is in retryableErrorCodes', () => {
    const result = service.classify(
      { kind: 'BUSINESS_REJECTION', errorCode: 'GENERATION_EXHAUSTED' },
      buildConfig({ retryableErrorCodes: ['GENERATION_EXHAUSTED'] }),
      2,
    );
    expect(result.outcome).toBe('RETRYABLE_FAILURE');
    if (result.outcome === 'RETRYABLE_FAILURE') {
      expect(result.nextDelayMs).toBe(1000); // 500 * 2^(2-1)
    }
  });

  // TC-7 (negative).
  it('TC-7: classifies an in-body CONFIG_NOT_BOUND error as PERMANENT_FAILURE when it is absent from retryableErrorCodes', () => {
    const result = service.classify(
      { kind: 'BUSINESS_REJECTION', errorCode: 'CONFIG_NOT_BOUND' },
      buildConfig({ retryableErrorCodes: ['GENERATION_EXHAUSTED'] }),
      1,
    );
    expect(result.outcome).toBe('PERMANENT_FAILURE');
    if (result.outcome === 'PERMANENT_FAILURE') {
      expect(result.reason).toContain('CONFIG_NOT_BOUND');
    }
  });

  it('classifies an in-body error with no retryableErrorCodes configured at all as PERMANENT_FAILURE', () => {
    const result = service.classify(
      { kind: 'BUSINESS_REJECTION', errorCode: 'INVALID_REQUEST' },
      buildConfig({ retryableErrorCodes: [] }),
      1,
    );
    expect(result.outcome).toBe('PERMANENT_FAILURE');
  });

  // TC-8.
  it('TC-8: computes backoff delay for retry_count = 3, base = 500, max = 30000 as 2000ms', () => {
    expect(service.computeBackoffDelayMs(3, 500, 30000)).toBe(2000); // 500 * 2^2
  });

  // TC-9.
  it('TC-9: caps backoff delay at retry_backoff_max_ms once the formula would exceed it', () => {
    const delay = service.computeBackoffDelayMs(20, 500, 30000);
    expect(delay).toBe(30000);
    expect(delay).toBeLessThanOrEqual(30000);
  });

  it('never exceeds retryBackoffMaxMs even when classify() computes the delay internally', () => {
    const result = service.classify(
      { kind: 'TRANSPORT_FAILURE', errorCode: 'ETIMEDOUT' },
      buildConfig({ retryBackoffBaseMs: 500, retryBackoffMaxMs: 30000 }),
      20,
    );
    expect(result.outcome).toBe('RETRYABLE_FAILURE');
    if (result.outcome === 'RETRYABLE_FAILURE') {
      expect(result.nextDelayMs).toBe(30000);
    }
  });
});
