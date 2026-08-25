/**
 * T-022 — the shared `QueryClient`'s default policy (04-FRONTEND.md §8 implementation
 * note 6).
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/apiError';
import {
  createQueryClient,
  queryClient,
  retryDelay,
  shouldRetryQuery,
} from '../../src/lib/queryClient';

function errorWithStatus(status: number, retryAfterSeconds?: number): ApiError {
  return new ApiError({ code: 'X', message: 'x', status, retryAfterSeconds });
}

describe('shouldRetryQuery', () => {
  it.each([401, 403, 404])('never retries a %i', (status) => {
    expect(shouldRetryQuery(0, errorWithStatus(status))).toBe(false);
    expect(shouldRetryQuery(1, errorWithStatus(status))).toBe(false);
  });

  it('retries a 500 up to twice (count < 2)', () => {
    expect(shouldRetryQuery(0, errorWithStatus(500))).toBe(true);
    expect(shouldRetryQuery(1, errorWithStatus(500))).toBe(true);
    expect(shouldRetryQuery(2, errorWithStatus(500))).toBe(false);
  });

  it('retries a 429 (rate limiting is not in the never-retry list, TC-11)', () => {
    expect(shouldRetryQuery(0, errorWithStatus(429))).toBe(true);
  });

  it('maps a raw, non-ApiError failure through toApiError before deciding', () => {
    // A bare Error carries no `.status`, which `toApiError` maps to `status: 0` — not in
    // the never-retry set, so it is still eligible (subject to the count cap).
    expect(shouldRetryQuery(0, new Error('boom'))).toBe(true);
  });
});

describe('retryDelay', () => {
  it('TC-11 — honours a 429’s Retry-After exactly, in milliseconds', () => {
    expect(retryDelay(0, errorWithStatus(429, 12))).toBe(12_000);
    expect(retryDelay(3, errorWithStatus(429, 12))).toBe(12_000);
  });

  it('a Retry-After of 0 is honoured as "no wait", not treated as absent', () => {
    expect(retryDelay(0, errorWithStatus(429, 0))).toBe(0);
  });

  it('backs off exponentially, capped at 30s, when there is no Retry-After', () => {
    expect(retryDelay(0, errorWithStatus(500))).toBe(1_000);
    expect(retryDelay(1, errorWithStatus(500))).toBe(2_000);
    expect(retryDelay(2, errorWithStatus(500))).toBe(4_000);
    expect(retryDelay(10, errorWithStatus(500))).toBe(30_000);
  });
});

describe('createQueryClient', () => {
  it('wires shouldRetryQuery and retryDelay as the query defaults', () => {
    const client = createQueryClient();
    const queryDefaults = client.getDefaultOptions().queries;

    expect(queryDefaults?.retry).toBe(shouldRetryQuery);
    expect(queryDefaults?.retryDelay).toBe(retryDelay);
    expect(queryDefaults?.refetchOnWindowFocus).toBe(false);
  });

  it('never blindly retries a mutation', () => {
    const client = createQueryClient();
    expect(client.getDefaultOptions().mutations?.retry).toBe(false);
  });

  it('builds an independent instance each call', () => {
    expect(createQueryClient()).not.toBe(createQueryClient());
  });
});

describe('queryClient', () => {
  it('is a ready-to-use singleton', () => {
    expect(queryClient.getDefaultOptions().queries?.retry).toBe(shouldRetryQuery);
  });
});
