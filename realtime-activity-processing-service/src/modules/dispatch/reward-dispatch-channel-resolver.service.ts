/**
 * T-INT-006. `RewardDispatchChannelResolverService` — the config-driven primary/fallback resolver
 * for this service's own `rap-to-rr` leg (`reward-service-integration-plan/TRANSPORT-CONFIG.md` —
 * `realtime_activity_processing.reward_dispatch_channel_config`, migration `017`), ported in
 * *shape* from RR's own `DispatchChannelResolverService`
 * (`reward-redemption-service/src/modules/dispatch/dispatch-channel-resolver.service.ts`,
 * T-RR-033/T-RR-062) — identical `REWARD -> TRACKER -> CAMPAIGN -> GLOBAL` first-match-wins
 * precedence walk, tenant-specific-before-tenant-agnostic within a level, three independently
 * toggleable channels (`KAFKA`/`REST`/`GRPC`), fail-loud when no row resolves at any scope
 * (including a missing `GLOBAL` row).
 *
 * **One deliberate departure from RR's own reference implementation**: this class owns a real,
 * self-contained `pg.Pool` and TTL cache directly, in one file — the same "own small `pg.Pool`,
 * never a shared runtime DB pool module, cache the resolved choice with a TTL, no separate
 * `POST /api/v1/cache/invalidate` controller in this task's own file scope" shape this service's
 * sibling resolver, `PortalConfigChannelResolverService`
 * (`src/modules/campaign-cache/portal-config-channel-resolver.service.ts`, T-INT-011), already
 * established — rather than RR's own three-file split (repository / TTL cache / resolver). RR's
 * split exists to let its `CacheInvalidationService`/`ReconciliationPollerService` (T-RR-007) reach
 * into a shared cache instance; this task's own "Files owned" list has no equivalent
 * cache-invalidation controller for this service (this service has no live
 * `POST /api/v1/cache/invalidate` HTTP surface at all yet — confirmed by direct read, same gap
 * `PortalConfigChannelResolverService`'s own header already recorded), so `invalidate()` is exposed
 * as a plain method any future caller can call directly, exactly as that file's own header
 * predicted ("a later leg's own `/api/v1/cache/invalidate` wiring, most likely landing alongside
 * T-INT-006's own `rap-to-rr` leg") — recorded as a Deviation in this task's own completion report,
 * not a silent gap.
 *
 * **Not registered as a class provider anywhere else in this module needs it to be** — like
 * `PortalConfigChannelResolverService`, this class's own constructor is fully `@Optional()`, so
 * plain Nest constructor-injection resolves it correctly with zero explicit provider wiring beyond
 * listing the class itself in `dispatch.module.ts`'s own `providers` array.
 */
import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { Pool } from 'pg';

export type RewardDispatchChannel = 'KAFKA' | 'REST' | 'GRPC';
export type RewardDispatchScopeLevel = 'REWARD' | 'TRACKER' | 'CAMPAIGN' | 'GLOBAL';

/** Migration `017`'s own column set, exactly — camelCase mirrors this service's own
 * `PortalConfigChannelConfigRow`/RR's `DispatchChannelConfigRow` convention. */
export interface RewardDispatchChannelConfigRow {
  id: number;
  scope_level: RewardDispatchScopeLevel;
  scope_ref_code: string | null;
  tenant_id: number | null;
  kafka_enabled: boolean;
  rest_enabled: boolean;
  grpc_enabled: boolean;
  primary_channel: RewardDispatchChannel;
  fallback_channel: RewardDispatchChannel;
  created_at: Date;
  updated_at: Date;
}

/** What `OutboxPublisherService.processRow` supplies to resolve which channel(s) should carry one
 * `reward_entry_outbox` row onward — every field is a *code* value or the `tenant_id` this row's own
 * `payload` already carries (`RewardEntryOutboxPayload`), never another service's internal id. */
export interface RewardDispatchChannelResolveContext {
  rewardCode?: string;
  trackerCode?: string;
  campaignCode?: string;
  tenantId?: number;
}

export interface ResolvedRewardDispatchChannel {
  primaryChannel: RewardDispatchChannel;
  fallbackChannel: RewardDispatchChannel;
  kafkaEnabled: boolean;
  restEnabled: boolean;
  grpcEnabled: boolean;
}

/** Thrown instead of returning a hardcoded default when no row resolves at any scope, including no
 * `GLOBAL` row — migration `017` seeds exactly one `GLOBAL` row, but this resolver must not assume
 * that seed survives a fresh/misconfigured environment (same fail-loud precedent
 * `DispatchChannelResolutionError`/`PortalConfigChannelResolutionError` already establish). */
export class RewardDispatchChannelResolutionError extends Error {
  constructor(context: RewardDispatchChannelResolveContext) {
    super(
      'No reward_dispatch_channel_config row resolved at any scope (REWARD, TRACKER, CAMPAIGN or ' +
        `GLOBAL) for context ${JSON.stringify(context)} — the GLOBAL row itself is missing or ` +
        'unreachable.',
    );
    this.name = 'RewardDispatchChannelResolutionError';
  }
}

const FIND_ONE_SQL = `
  SELECT * FROM realtime_activity_processing.reward_dispatch_channel_config
  WHERE scope_level = $1
    AND scope_ref_code IS NOT DISTINCT FROM $2
    AND tenant_id IS NOT DISTINCT FROM $3
`;

function toResolved(row: RewardDispatchChannelConfigRow): ResolvedRewardDispatchChannel {
  return {
    primaryChannel: row.primary_channel,
    fallbackChannel: row.fallback_channel,
    kafkaEnabled: row.kafka_enabled,
    restEnabled: row.rest_enabled,
    grpcEnabled: row.grpc_enabled,
  };
}

interface Candidate {
  level: RewardDispatchScopeLevel;
  refCode: string | null;
}

/** `value: null` is a valid, cacheable outcome ("confirmed: no row at this exact triple") — cached
 * exactly like a real hit, distinct from "not yet looked up at all" (no entry in the map). Without
 * this, a tenant-specific miss (the common case whenever `tenantId` is present) would re-query the
 * DB on every single `resolve()` call, defeating the TTL cache's purpose for exactly the shape of
 * lookup `resolveAtLevel` makes most often — same reasoning
 * `PortalConfigChannelResolverService`'s own `CacheEntry` doc comment gives. */
interface CacheEntry {
  value: ResolvedRewardDispatchChannel | null;
  expiresAt: number;
}

/** `REWARD_DISPATCH_CHANNEL_CACHE_TTL_MS` — read directly from `process.env` (not
 * `ConfigService`/`config.schema.ts`, out of `agent-rap-foundation`'s file scope, same precedent
 * `portal-config-channel-resolver.service.ts`'s own `PORTAL_CONFIG_CHANNEL_CACHE_TTL_MS` already
 * sets). Defaults to one minute: short enough that a local `set-transport-primary.js` switch is
 * visible within one outbox poll cycle without any invalidation call, generous enough not to turn
 * every dispatch attempt into a DB round trip in steady state. */
export const DEFAULT_CACHE_TTL_MS = 60_000;

function loadCacheTtlMs(): number {
  const raw = process.env.REWARD_DISPATCH_CHANNEL_CACHE_TTL_MS?.trim();
  if (!raw) return DEFAULT_CACHE_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid REWARD_DISPATCH_CHANNEL_CACHE_TTL_MS: "${raw}" is not a positive integer`,
    );
  }
  return parsed;
}

@Injectable()
export class RewardDispatchChannelResolverService implements OnModuleDestroy {
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

  /** TC-1/TC-2. Walks `REWARD -> TRACKER -> CAMPAIGN -> GLOBAL`, first match wins outright (never a
   * field-by-field merge across levels) — every field of the returned shape comes from that one
   * row. */
  async resolve(
    context: RewardDispatchChannelResolveContext,
  ): Promise<ResolvedRewardDispatchChannel> {
    const tenantId = context.tenantId ?? null;

    const candidates: Candidate[] = [];
    if (context.rewardCode !== undefined) {
      candidates.push({ level: 'REWARD', refCode: context.rewardCode });
    }
    if (context.trackerCode !== undefined) {
      candidates.push({ level: 'TRACKER', refCode: context.trackerCode });
    }
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

    throw new RewardDispatchChannelResolutionError(context);
  }

  /** Within one scope level, a tenant-specific row wins over the tenant-agnostic row at that same
   * level — checked before falling through to the next scope level entirely (same TC-5-style
   * precedent every other resolver in this plan follows). */
  private async resolveAtLevel(
    level: RewardDispatchScopeLevel,
    refCode: string | null,
    tenantId: number | null,
  ): Promise<ResolvedRewardDispatchChannel | null> {
    if (tenantId !== null) {
      const tenantSpecific = await this.lookup(level, refCode, tenantId);
      if (tenantSpecific) {
        return tenantSpecific;
      }
    }
    return this.lookup(level, refCode, null);
  }

  private cacheKey(
    level: RewardDispatchScopeLevel,
    refCode: string | null,
    tenantId: number | null,
  ): string {
    return `${level}::${refCode ?? ''}::${tenantId ?? ''}`;
  }

  private async lookup(
    level: RewardDispatchScopeLevel,
    refCode: string | null,
    tenantId: number | null,
  ): Promise<ResolvedRewardDispatchChannel | null> {
    const key = this.cacheKey(level, refCode, tenantId);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }

    const result = await this.pool.query<RewardDispatchChannelConfigRow>(FIND_ONE_SQL, [
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
   * contract every sibling resolver's own `invalidate()` documents. Callable directly today (no
   * live `/api/v1/cache/invalidate` HTTP surface exists in this service yet — see this file's own
   * header); `set-transport-primary.js`'s own `POST /api/v1/cache/invalidate` call for the
   * `rap-to-rr` leg degrades to "DB row updated, cache catches up within
   * `REWARD_DISPATCH_CHANNEL_CACHE_TTL_MS`" in the meantime, exactly as that script's own fallback
   * warning already describes for any service with no reachable invalidate endpoint. */
  invalidate(): void {
    this.cache.clear();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
