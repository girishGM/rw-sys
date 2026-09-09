/**
 * T-INT-011. `PortalConfigChannelResolverService` — the config-driven primary/fallback resolver
 * for this service's own `portal-config` leg (`reward-service-integration-plan/TRANSPORT-CONFIG.md`
 * — `realtime_activity_processing.portal_config_channel_config`, migration `016`), ported in
 * *shape* from `PromoCodeChannelResolverService`
 * (`reward-redemption-service/src/modules/connectors/promo-code-channel-resolver.service.ts`,
 * T-RR-080) — same first-match-wins precedence walk, same "own small `pg.Pool`, never a shared
 * runtime DB pool module" precedent, same fail-loud-on-no-`GLOBAL`-row contract.
 *
 * **Two deliberate departures from the reference implementation, both explained there and worth
 * restating here:**
 *
 * 1. **Precedence is `CAMPAIGN → GLOBAL` only, not the full `REWARD → TRACKER → CAMPAIGN →
 *    GLOBAL`.** `CampaignConfigClient`'s own two public methods this resolver serves
 *    (`listActiveCampaigns`, `getCampaignConfig`) only ever carry a `tenantId` and, for
 *    `getCampaignConfig`, a `campaignCode` — there is no reward/tracker context at the point this
 *    leg's transport decision is made (fetching campaign config is what happens *before* any
 *    reward/tracker is even known). The table itself still carries the full
 *    `scope_level`/`scope_ref_code` shape (migration `016`'s own header) so a future, more granular
 *    override is possible without a schema change — this resolver just never constructs a
 *    `REWARD`/`TRACKER` candidate today.
 * 2. **This resolver owns a real, invalidatable TTL cache directly** (implementation note 4:
 *    "cache the resolved primary/fallback choice with a TTL... don't hit the DB on every
 *    campaign-config fetch"), unlike `PromoCodeChannelResolverService`, which is deliberately
 *    **not** cached (that class's own header: a synchronous, once-per-redemption-attempt decision,
 *    not a high-frequency poll-cycle read). This leg is the opposite: `CampaignConfigCacheService`
 *    calls through `campaign-config.client.ts` on every reconciliation poll cycle and every
 *    `WatchCampaignConfig` reconnect attempt (`invalidation/reconciliation-poller.service.ts`), so
 *    resolving the transport choice on every one of those calls would mean a real, avoidable
 *    per-poll DB round trip. This task's own "Files owned" list does not include a separate
 *    `POST /api/v1/cache/invalidate` controller/module (RAP has no live cache-invalidation HTTP
 *    surface at all yet — `campaign-config-cache.module.ts`'s own header confirms it, and this
 *    service's own `CLAUDE.md` "Standalone entry points" table confirms nothing beyond
 *    `ConfigModule`+`HealthModule` is wired into `AppModule` today), so `invalidate()` is exposed
 *    as a plain method any future caller (a later leg's own `/api/v1/cache/invalidate` wiring, most
 *    likely landing alongside T-INT-006's own `rap-to-rr` leg, which needs the identical surface)
 *    can call directly — recorded as a Deviation in this task's own completion report, not a
 *    silent gap.
 */
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { Pool } from 'pg';

export type PortalConfigChannel = 'REST' | 'GRPC';
export type PortalConfigChannelScopeLevel = 'CAMPAIGN' | 'GLOBAL';

/** Migration `016`'s own column set, exactly — camelCase mirrors
 * `DispatchChannelConfigRow`/`PromoCodeChannelConfigRow`'s own convention for the equivalent row
 * shape in RR. */
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
 * `GLOBAL` row — migration `016` seeds exactly one `GLOBAL` row, but this resolver must not assume
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
  SELECT * FROM realtime_activity_processing.portal_config_channel_config
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
 * `ConfigService`/`config.schema.ts`, out of `agent-rap-foundation`'s file scope, same precedent
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
   * contract `DispatchChannelConfigCache#invalidate` documents. Callable directly today (no live
   * `/api/v1/cache/invalidate` HTTP surface exists in this service yet — see this file's own
   * header); `set-transport-primary.js`'s own `POST /api/v1/cache/invalidate` call for this leg
   * degrades to "DB row updated, cache catches up within `PORTAL_CONFIG_CHANNEL_CACHE_TTL_MS`" in
   * the meantime, exactly as that script's own fallback warning already describes for any service
   * with no reachable invalidate endpoint. */
  invalidate(): void {
    this.cache.clear();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
