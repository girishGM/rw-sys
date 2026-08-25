/**
 * T-022 — the shared `QueryClient` and its default policy (04-FRONTEND.md §8 implementation
 * note 6, §9).
 *
 * One instance, imported by `AppProviders` (T-020) and by `apiClient`'s refresh-failure
 * path (`clearSessionAndRedirect`) alike, so "clear the cache" always means clearing the
 * cache the app is actually rendering from — a second, unreachable `QueryClient` would make
 * `queryClient.clear()` a no-op nobody would notice until a shared machine leaked the
 * previous user's data (04-FRONTEND.md §9).
 */
import { QueryClient } from '@tanstack/react-query';
import { ApiError, toApiError } from './apiError';

/** `count < 2` — at most two retries, i.e. three attempts total. */
const MAX_RETRIES = 2;

/** Retrying these is either pointless (403/404 will not become permitted by trying again) or actively
 * looks like an attack in the audit log (04-FRONTEND.md §8 implementation note 6). 401 is excluded
 * too — that is `apiClient`'s single-flight refresh's job, not TanStack Query's retry loop. */
const NEVER_RETRY_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

/** Exponential backoff, capped, for everything that does not carry its own `Retry-After`. */
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

function toKnownError(error: unknown): ApiError {
  return error instanceof ApiError ? error : toApiError(error);
}

/**
 * `retry: (count, err) => count < 2 && ![401,403,404].includes(err.status)` — copied verbatim
 * from 04-FRONTEND.md §8's own spec, just spelled out as a named function so it is testable on
 * its own.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  return !NEVER_RETRY_STATUSES.has(toKnownError(error).status);
}

/**
 * TC-11: a 429's `Retry-After` is honoured rather than hammered with the same backoff every
 * other failure gets. Everything else backs off exponentially, capped at 30s.
 */
export function retryDelay(attemptIndex: number, error: unknown): number {
  const retryAfterSeconds = toKnownError(error).retryAfterSeconds;
  if (retryAfterSeconds !== undefined) {
    return retryAfterSeconds * 1000;
  }
  return Math.min(BASE_DELAY_MS * 2 ** attemptIndex, MAX_DELAY_MS);
}

/** Builds a fresh client with the shared policy. Exported (not just the singleton) so tests
 * that need an isolated cache do not have to reach for a private instance. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryQuery,
        retryDelay,
        refetchOnWindowFocus: false,
      },
      mutations: {
        // A mutation is rarely idempotent (a POST that creates a campaign, say) — retrying
        // one blindly risks a duplicate side effect. Callers that know their mutation is
        // safe to retry opt in per-call.
        retry: false,
      },
    },
  });
}

/** The one instance the running application shares. */
export const queryClient = createQueryClient();
