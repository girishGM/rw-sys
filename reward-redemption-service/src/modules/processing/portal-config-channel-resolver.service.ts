/**
 * T-INT-012. `PortalConfigChannelResolverService` — the config-driven primary/fallback resolver
 * for this service's own `portal-config` leg (`reward-service-integration-plan/TRANSPORT-CONFIG.md`
 * — `reward_redemption.portal_config_channel_config`, migration `025`), an explicit direct port of
 * RAP's own identical resolver
 * (`realtime-activity-processing-service/src/modules/campaign-cache/portal-config-channel-resolver.service.ts`,
 * T-INT-011 — confirmed by direct read before diverging in shape, per this task's own
 * implementation note 1) — same first-match-wins precedence walk, same TTL cache with an
 * `invalidate()` escape hatch, same fail-loud-on-no-`GLOBAL`-row contract. Also structurally close
 * to `PromoCodeChannelResolverService`
 * (`reward-redemption-service/src/modules/connectors/promo-code-channel-resolver.service.ts`,
 * T-RR-080) — this service's own established "own small `pg.Pool`, never a shared runtime DB pool
 * module" precedent — with the same two departures RAP's own header already records relative to
 * that class:
 *
 * 1. **Precedence is `CAMPAIGN → GLOBAL` only, not the full `REWARD → TRACKER → CAMPAIGN →
 *    GLOBAL`.** `CampaignConfigClient`'s own two public methods this resolver serves
 *    (`listActiveCampaigns`, `getCampaignConfig`) only ever carry a `tenantId` and, for
 *    `getCampaignConfig`, a `campaignCode` — there is no reward/tracker context at the point this
 *    leg's transport decision is made. The table itself still carries the full `scope_level`/
 *    `scope_ref_code` shape (migration `025`'s own header) so a future, more granular override is
 *    possible without a schema change — this resolver just never constructs a `REWARD`/`TRACKER`
 *    candidate today.
 * 2. **This resolver owns a real, invalidatable TTL cache directly**, unlike
 *    `PromoCodeChannelResolverService` (deliberately not cached — a synchronous, once-per-redemption
 *    decision, not a high-frequency poll-cycle read). This leg's own caller,
 *    `CampaignConfigCache` (T-RR-022, out of this task's own "Files owned" scope), polls on a TTL
 *    of its own, so resolving the transport choice on every one of those calls would mean a real,
 *    avoidable per-poll DB round trip.
 *
 * **Env vars read directly from `process.env`, not `ConfigService`/`src/config/config.schema.ts`**:
 * `src/config/**` is `agent-rr-foundation`'s own file scope, matching the identical precedent
 * `campaign-config.client.ts`'s own header already sets for `PORTAL_GRPC_*`.
 *
 * **No `POST /api/v1/cache/invalidate` wiring for this leg's `campaignConfigChannel` cache key** —
 * see this task's own completion report under "Deviations" for why (`cache-invalidation.service.ts`
 * is not in this task's own "Files owned" list, unlike RAP/RTS this service already has a *live*
 * `POST /api/v1/cache/invalidate` endpoint (T-RR-007), so wiring the key in is a one-line follow-up
 * once someone owns that file for this purpose). `invalidate()` below is a public method any future
 * caller can reach directly (proven in this file's own TC-4 unit test); the TTL
 * (`PORTAL_CONFIG_CHANNEL_CACHE_TTL_MS`, default 60s) is the fallback freshness mechanism until then.
 */
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { Pool } from 'pg';

export type PortalConfigChannel = 'REST' | 'GRPC';
export type PortalConfigChannelScopeLevel = 'CAMPAIGN' | 'GLOBAL';

/** Migration `025`'s own column set, exactly — camelCase mirrors
 * `DispatchChannelConfigRow`/`PromoCodeChannelConfigRow`'s own convention for the equivalent row
 * shape in this service. */
export interface PortalConfigChannelConfigRow {
  id: number;
  scope_level: PortalConfigChannelScopeLevel;
  scope_ref_code: string | null;
  tenant_id: number | null;
  rest_enabled: boolean;
  grpc_enabled: boolean;
  primary_channel: PortalConfigChannel;
  fallback_channel: PortalConfigChannel;
  created_at: Date;
  updated_at: Date;
}

/** What a caller (`campaign-config.client.ts`) supplies to resolve which transport should serve
 * one call. `tenantId` is always known (every `CampaignConfigClient` method takes one);
 * `campaignCode` is only known for `getCampaignConfig`, never `listActiveCampaigns`. */
export interface PortalConfigChannelResolveContext {
  campaignCode?: string;
  tenantId?: number;
}

export interface ResolvedPortalConfigChannel {
  primaryChannel: PortalConfigChannel;
  fallbackChannel: PortalConfigChannel;
  restEnabled: boolean;
  grpcEnabled: boolean;
}

/** Thrown instead of returning a hardcoded default when no row resolves at any scope, including no
 * `GLOBAL` row — migration `025` seeds exactly one `GLOBAL` row, but this resolver must not assume
 * that seed survives a fresh/misconfigured environment (same fail-loud precedent as
 * `DispatchChannelResolutionError`/`PromoCodeChannelResolutionError`). */
export class PortalConfigChannelResolutionError extends Error {
  constructor(context: PortalConfigChannelResolveContext) {
    super(
      'No portal_config_channel_config row resolved at any scope (CAMPAIGN or GLOBAL) for ' +
        `context ${JSON.stringify(context)} — the GLOBAL row itself is missing or unreachable.`,
    );
    this.name = 'PortalConfigChannelResolutionError';
  }
}

const FIND_ONE_SQL = `
  SELECT * FROM reward_redemption.portal_config_channel_config
  WHERE scope_level = $1
    AND scope_ref_code IS NOT DISTINCT FROM $2
    AND tenant_id IS NOT DISTINCT FROM $3
`;

function toResolved(row: PortalConfigChannelConfigRow): ResolvedPortalConfigChannel {
  return {
    primaryChannel: row.primary_channel,
    fallbackChannel: row.fallback_channel,
    restEnabled: row.rest_enabled,
    grpcEnabled: row.grpc_enabled,
  };
}

interface Candidate {
  level: PortalConfigChannelScopeLevel;
  refCode: string | null;
}

/** `value: null` is a valid, cacheable outcome ("confirmed: no row at this exact triple") — cached
 * exactly like a real hit, distinct from "not yet looked up at all" (no entry in the map). Without
 * this, `resolveAtLevel`'s own tenant-specific-before-tenant-agnostic check (TC-5-style precedence)
 * would re-query the DB for the tenant-specific miss on *every single* `resolve()` call whenever a
 * `tenantId` is present — the one candidate that, in the common case, resolves to nothing at all —
 * defeating the TTL cache's entire purpose for exactly the shape of call this leg makes most often. */
interface CacheEntry {
  value: ResolvedPortalConfigChannel | null;
  expiresAt: number;
}

/** `PORTAL_CONFIG_CHANNEL_CACHE_TTL_MS` — read directly from `process.env` (not
 * `ConfigService`/`config.schema.ts`, out of `agent-rr-foundation`'s file scope, same precedent
 * `campaign-config.client.ts`'s own env-var loading already sets). Defaults to one minute: short
 * enough that a local `set-transport-primary.js` switch (TC-4) is visible within one poll cycle
 * without any invalidation call, generous enough not to turn every cache-hit path into a
 * DB round trip in steady state. */
export const DEFAULT_CACHE_TTL_MS = 60_000;

function loadCacheTtlMs(): number {
  const raw = process.env.PORTAL_CONFIG_CHANNEL_CACHE_TTL_MS?.trim();
  if (!raw) return DEFAULT_CACHE_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid PORTAL_CONFIG_CHANNEL_CACHE_TTL_MS: "${raw}" is not a positive integer`,
    );
  }
  return parsed;
}

@Injectable()
export class PortalConfigChannelResolverService implements OnModuleDestroy {
  private readonly logger = new Logger(PortalConfigChannelResolverService.name);
  private readonly pool: Pool;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Optional() pool?: Pool,
    @Optional() private readonly now: () => number = () => Date.now(),
    @Optional() ttlMs?: number,
  ) {
    this.pool =
      pool ??
      new Pool({
        host: process.env.DB_HOST ?? 'localhost',
        port: process.env.DB_PORT ? Number.parseInt(process.env.DB_PORT, 10) : 5432,
        database: process.env.DB_NAME,
        user: process.env.DB_APP_USERNAME,
        password: process.env.DB_APP_PASSWORD,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      });
    this.ttlMs = ttlMs ?? loadCacheTtlMs();
  }

  async resolve(context: PortalConfigChannelResolveContext): Promise<ResolvedPortalConfigChannel> {
    const tenantId = context.tenantId ?? null;

    const candidates: Candidate[] = [];
    if (context.campaignCode !== undefined) {
      candidates.push({ level: 'CAMPAIGN', refCode: context.campaignCode });
    }
    candidates.push({ level: 'GLOBAL', refCode: null });

    for (const { level, refCode } of candidates) {
      const resolved = await this.resolveAtLevel(level, refCode, tenantId);
      if (resolved) {
        return resolved;
      }
    }

    throw new PortalConfigChannelResolutionError(context);
  }

  /** Within one scope level, a tenant-specific row wins over the tenant-agnostic row at that same
   * level — checked before falling through to the next scope level entirely (same TC-5 precedent
   * every other resolver in this plan follows). */
  private async resolveAtLevel(
    level: PortalConfigChannelScopeLevel,
    refCode: string | null,
    tenantId: number | null,
  ): Promise<ResolvedPortalConfigChannel | null> {
    if (tenantId !== null) {
      const tenantSpecific = await this.lookup(level, refCode, tenantId);
      if (tenantSpecific) {
        return tenantSpecific;
      }
    }
    return this.lookup(level, refCode, null);
  }

  private cacheKey(
    level: PortalConfigChannelScopeLevel,
    refCode: string | null,
    tenantId: number | null,
  ): string {
    return `${level}::${refCode ?? ''}::${tenantId ?? ''}`;
  }

  private async lookup(
    level: PortalConfigChannelScopeLevel,
    refCode: string | null,
    tenantId: number | null,
  ): Promise<ResolvedPortalConfigChannel | null> {
    const key = this.cacheKey(level, refCode, tenantId);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }

    const result = await this.pool.query<PortalConfigChannelConfigRow>(FIND_ONE_SQL, [
      level,
      refCode,
      tenantId,
    ]);
    const row = result.rows[0] ?? null;
    const resolved = row === null ? null : toResolved(row);
    this.cache.set(key, { value: resolved, expiresAt: this.now() + this.ttlMs });
    return resolved;
  }

  /** Clears every cached entry — the same "no scoped clear, next `resolve()` re-fills lazily"
   * contract `DispatchChannelConfigCache#invalidate` documents. Callable directly today (no
   * `campaignConfigChannel` key wired into the live `POST /api/v1/cache/invalidate` endpoint yet —
   * see this file's own header); `set-transport-primary.js`'s own invalidate call for this leg
   * degrades to "DB row updated, cache catches up within `PORTAL_CONFIG_CHANNEL_CACHE_TTL_MS`" in
   * the meantime, exactly as that script's own fallback warning already describes for a leg with no
   * wired cache key. */
  invalidate(): void {
    this.cache.clear();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
