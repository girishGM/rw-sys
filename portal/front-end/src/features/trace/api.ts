/**
 * T-045 — the one call this feature makes: `GET /audit/trace/:correlationId`
 * (08-OBSERVABILITY.md §6).
 *
 * Uses `lib/apiClient.ts`'s shared `api` instance (T-022) rather than a bare axios client —
 * unlike `useBootstrap.ts`'s deliberately bare client (a `GET` that must not be caught up in the
 * refresh queue before there is even a session), this call is a perfectly ordinary authenticated
 * `GET` and wants everything `api` already does: CSRF is a no-op for `GET` anyway, but the
 * single-flight 401 refresh and transport-payload decryption both apply here exactly as they do
 * to every other feature call.
 */
import { traceResponseSchema, type TraceResponse } from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

/** `useQuery({ queryKey: traceQueryKey(id), ... })` — one cache entry per correlation id. */
export function traceQueryKey(correlationId: string): readonly [string, string] {
  return ['trace', correlationId] as const;
}

/**
 * Fetches and validates one trace.
 *
 * The response is parsed through `traceResponseSchema` — not just cast — so a server/SPA contract
 * drift (a masked field the schema does not expect, a renamed key) surfaces as a caught, reported
 * error on this one screen rather than as a silent `undefined` deep in the waterfall renderer.
 */
export async function fetchTrace(correlationId: string): Promise<TraceResponse> {
  try {
    const response = await api.get<{ data: unknown }>(
      `/audit/trace/${encodeURIComponent(correlationId)}`,
    );
    const parsed = traceResponseSchema.safeParse(response.data.data);
    if (!parsed.success) {
      throw new Error(
        `Trace response did not match the expected shape: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  } catch (error) {
    throw toApiError(error);
  }
}
