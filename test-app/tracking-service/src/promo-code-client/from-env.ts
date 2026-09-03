/**
 * Builds a {@link PromoCodeClient} from `PROMO_CODE_SERVICE_BASE_URL` /
 * `PROMO_CODE_SERVICE_GENERATION_TOKEN` (`.env.example`) — or returns `null` when either is
 * unset. Deliberately not the "throw on missing config" contract `portal-client/from-env.ts`
 * uses: the portal connection is load-bearing for this app to boot at all, but promo-code-service
 * is an optional integration a `promo_code`-unit reward degrades gracefully without (see
 * `engine/reward.ts`'s fallback path) — a misconfigured deployment shouldn't refuse to start over
 * a reward kind it may not even use.
 */
import { PromoCodeClient } from './client';

export function createPromoCodeClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PromoCodeClient | null {
  const baseUrl = env.PROMO_CODE_SERVICE_BASE_URL;
  const generationToken = env.PROMO_CODE_SERVICE_GENERATION_TOKEN;
  if (!baseUrl || baseUrl.trim().length === 0) return null;
  if (!generationToken || generationToken.trim().length === 0) return null;

  return new PromoCodeClient({ baseUrl, generationToken });
}
