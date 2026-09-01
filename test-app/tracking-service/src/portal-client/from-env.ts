/**
 * T-003 — builds a {@link PortalClient} from the three env vars `.env.example` documents
 * (`PORTAL_BASE_URL`, `PORTAL_LOGIN_EMAIL`, `PORTAL_LOGIN_PASSWORD`). Separate from `client.ts`
 * so the client itself stays free of `process.env` and fully unit-testable via
 * {@link PortalClientConfig} alone.
 */
import { PortalClient } from './client';

export function createPortalClientFromEnv(env: NodeJS.ProcessEnv = process.env): PortalClient {
  const baseUrl = env.PORTAL_BASE_URL;
  const loginEmail = env.PORTAL_LOGIN_EMAIL;
  const loginPassword = env.PORTAL_LOGIN_PASSWORD;

  const missing = (
    ['PORTAL_BASE_URL', 'PORTAL_LOGIN_EMAIL', 'PORTAL_LOGIN_PASSWORD'] as const
  ).filter((key) => !env[key] || env[key]?.trim().length === 0);
  if (missing.length > 0) {
    throw new Error(
      `createPortalClientFromEnv: missing required env var(s): ${missing.join(', ')} — see .env.example`,
    );
  }

  const rawTtl = env.PORTAL_CACHE_TTL_MS;
  const cacheTtlMs = rawTtl && rawTtl.trim().length > 0 ? Number(rawTtl) : undefined;
  if (cacheTtlMs !== undefined && (!Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0)) {
    throw new Error(
      `createPortalClientFromEnv: PORTAL_CACHE_TTL_MS must be a positive number, got "${rawTtl}"`,
    );
  }

  return new PortalClient({
    baseUrl: baseUrl as string,
    loginEmail: loginEmail as string,
    loginPassword: loginPassword as string,
    ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}),
  });
}
