/**
 * T-022 — `toApiError`, the single point every raw failure is funnelled through
 * (04-FRONTEND.md §8 implementation note 5).
 *
 * `apiClient.spec.ts` asserts the same codes end-to-end through the real interceptor
 * chain; this file is the exhaustive, fast, unit-level coverage of the mapping itself —
 * every branch of `toApiError`, not just the ones a particular HTTP exchange happens to
 * exercise.
 */
import {
  AxiosError,
  AxiosHeaders,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { describe, expect, it } from 'vitest';
import { ApiError, CLIENT_ERROR_CODE, toApiError } from '../../src/lib/apiError';
import { TransportCryptoError } from '../../src/lib/transportCrypto';

function fakeConfig(): InternalAxiosRequestConfig {
  return { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
}

function axiosErrorWithResponse(
  status: number,
  data: unknown,
  headers?: Record<string, string>,
): AxiosError {
  const config = fakeConfig();
  const response = {
    data,
    status,
    statusText: '',
    headers: headers ?? {},
    config,
  } as AxiosResponse;
  return new AxiosError('Request failed', undefined, config, {}, response);
}

describe('toApiError', () => {
  it('passes an existing ApiError through unchanged', () => {
    const original = new ApiError({ code: 'X', message: 'already mapped', status: 400 });
    expect(toApiError(original)).toBe(original);
  });

  it('TC-10 — a 403 server envelope maps its own code straight through', () => {
    const error = axiosErrorWithResponse(403, {
      error: { code: 'PERM_DENIED', message: 'You do not have permission.', traceId: 't-1' },
    });
    const mapped = toApiError(error);
    expect(mapped.status).toBe(403);
    expect(mapped.code).toBe('PERM_DENIED');
    expect(mapped.message).toBe('You do not have permission.');
    expect(mapped.traceId).toBe('t-1');
  });

  it('falls back to the catalogue code for a status with no envelope at all (e.g. a proxy 403)', () => {
    const error = axiosErrorWithResponse(403, undefined);
    expect(toApiError(error).code).toBe('PERM_DENIED');
  });

  it('falls back to INTERNAL_ERROR for an unmapped status with no envelope', () => {
    const error = axiosErrorWithResponse(502, undefined);
    expect(toApiError(error).code).toBe('INTERNAL_ERROR');
  });

  it('TC-12 — a 500 carries its traceId through', () => {
    const error = axiosErrorWithResponse(500, {
      error: { code: 'INTERNAL_ERROR', message: 'Something broke.', traceId: 'trace-xyz' },
    });
    const mapped = toApiError(error);
    expect(mapped.status).toBe(500);
    expect(mapped.traceId).toBe('trace-xyz');
  });

  it('TC-15 — a 400 validation failure exposes a well-formed details array', () => {
    const error = axiosErrorWithResponse(400, {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Fix the highlighted fields.',
        details: [{ field: 'startDate', code: 'DATE_IN_PAST' }],
        traceId: 't-2',
      },
    });
    const mapped = toApiError(error);
    expect(mapped.code).toBe('VALIDATION_FAILED');
    expect(mapped.details).toEqual([{ field: 'startDate', code: 'DATE_IN_PAST' }]);
  });

  it('drops a details entry that is not a well-formed {field, code} pair', () => {
    const error = axiosErrorWithResponse(400, {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Fix the highlighted fields.',
        details: [
          { field: 'startDate', code: 'DATE_IN_PAST' },
          { field: 'onlyField' },
          'not an object',
        ],
        traceId: 't-3',
      },
    });
    expect(toApiError(error).details).toEqual([{ field: 'startDate', code: 'DATE_IN_PAST' }]);
  });

  it('leaves details undefined when the array is present but empty', () => {
    const error = axiosErrorWithResponse(400, {
      error: { code: 'VALIDATION_FAILED', message: 'x', details: [], traceId: 't-4' },
    });
    expect(toApiError(error).details).toBeUndefined();
  });

  it.each([
    ['30', 30],
    ['0', 0],
    ['120', 120],
  ])(
    'TC-11 — a 429 with a numeric Retry-After of %s seconds is parsed to %i',
    (header, expected) => {
      const error = axiosErrorWithResponse(
        429,
        { error: { code: 'RATE_LIMITED', message: 'Slow down.', traceId: 't-5' } },
        { 'retry-after': header },
      );
      expect(toApiError(error).retryAfterSeconds).toBe(expected);
    },
  );

  it('TC-11 — a 429 with an HTTP-date Retry-After is converted to a positive delta in seconds', () => {
    const future = new Date(Date.now() + 90_000).toUTCString();
    const error = axiosErrorWithResponse(
      429,
      { error: { code: 'RATE_LIMITED', message: 'Slow down.', traceId: 't-6' } },
      { 'retry-after': future },
    );
    const seconds = toApiError(error).retryAfterSeconds;
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(90);
  });

  it('a 429 with an unparseable Retry-After degrades to no special wait, not a wrong one', () => {
    const error = axiosErrorWithResponse(
      429,
      { error: { code: 'RATE_LIMITED', message: 'Slow down.', traceId: 't-7' } },
      { 'retry-after': 'not a valid value' },
    );
    expect(toApiError(error).retryAfterSeconds).toBeUndefined();
  });

  it('a non-429 status never carries a retryAfterSeconds, even with the header present', () => {
    const error = axiosErrorWithResponse(
      500,
      { error: { code: 'INTERNAL_ERROR', message: 'x', traceId: 't-8' } },
      { 'retry-after': '30' },
    );
    expect(toApiError(error).retryAfterSeconds).toBeUndefined();
  });

  it('TC-13 — an AxiosError with no response (network failure) becomes a friendly, non-raw message', () => {
    const config = fakeConfig();
    const error = new AxiosError('Network Error', AxiosError.ERR_NETWORK, config);
    const mapped = toApiError(error);

    expect(mapped).toBeInstanceOf(ApiError);
    expect(mapped.status).toBe(0);
    expect(mapped.code).toBe(CLIENT_ERROR_CODE.NETWORK_ERROR);
    expect(mapped.message).not.toMatch(/Network Error/);
    expect(mapped.message.toLowerCase()).toContain('offline');
  });

  it('maps a TransportCryptoError to its own client-side code, keeping the scrubbed message', () => {
    const original = new TransportCryptoError(
      'Could not decrypt the response payload.',
      'decrypt_failed',
    );
    const mapped = toApiError(original);

    expect(mapped.code).toBe(CLIENT_ERROR_CODE.TRANSPORT_CRYPTO_ERROR);
    expect(mapped.status).toBe(0);
    expect(mapped.message).toBe(original.message);
  });

  it('maps anything else at all — a bare Error, a string, undefined — to a generic, safe ApiError', () => {
    expect(toApiError(new Error('boom')).code).toBe(CLIENT_ERROR_CODE.UNKNOWN_ERROR);
    expect(toApiError('a bare string').code).toBe(CLIENT_ERROR_CODE.UNKNOWN_ERROR);
    expect(toApiError(undefined).code).toBe(CLIENT_ERROR_CODE.UNKNOWN_ERROR);
    expect(toApiError(undefined).status).toBe(0);
  });

  it('treats a non-string envelope code/message as absent rather than trusting an unexpected shape', () => {
    const error = axiosErrorWithResponse(404, { error: { code: 42, message: null } });
    const mapped = toApiError(error);
    expect(mapped.code).toBe('NOT_FOUND');
    expect(mapped.message.length).toBeGreaterThan(0);
  });

  it('treats an array response body as having no envelope, not a crash', () => {
    const error = axiosErrorWithResponse(500, [1, 2, 3]);
    expect(toApiError(error).code).toBe('INTERNAL_ERROR');
  });
});
