/**
 * T-RR-080. `PromoCodeChannelResolverService` — the first-match-wins precedence walk
 * `REWARD → TRACKER → CAMPAIGN → GLOBAL` over `reward_redemption.promo_code_channel_config`
 * (migration `018`), ported in *shape* from `DispatchChannelResolverService`'s own algorithm
 * (`dispatch-channel-resolver.service.ts:82-126`, T-RR-033) — same tenant-specific-before-tenant-
 * agnostic rule at each level, same first-match-wins/never-a-merge semantics — for a different
 * question ("which transport does *this* redemption use to reach promo-code-service") and a
 * different direction (a synchronous outbound call this service makes and blocks on, not a
 * fire-and-forget event it dispatches — see T-RR-080's own task file, "Why this reuses
 * dispatch_channel_config's shape but isn't the same table").
 *
 * Deliberately **not** cached (unlike `DispatchChannelConfigCache`): every `redeem()` call is a
 * synchronous, money-bearing decision made once per attempt, not a high-frequency poll-cycle read —
 * always resolving live against the current row avoids a stale-channel-decision class of bug a TTL
 * cache would otherwise introduce for no real performance benefit here. Owns its own small `pg.Pool`
 * (never a transaction, never opened by a caller) — same "one small pool per resolver/repository,
 * no shared runtime DB pool module" precedent `DispatchChannelConfigRepository`/
 * `PromoCodeServiceConnector` already established; the second constructor parameter exists solely
 * so a test can substitute a real (but test-owned) `Pool`.
 */
import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import type {
  PromoCodeChannel,
  PromoCodeChannelConfigRow,
  PromoCodeChannelScopeLevel,
} from '@/database/models/promo-code-channel-config.model';

/**
 * Every field is a *code* value or the `tenant_id` int this service's own tables already carry
 * (`reward_redemption_entry.tenant_id`) — never another service's internal id, mirroring
 * `DispatchChannelResolveContext`'s own convention. A field left `undefined` means that scope level
 * can never match.
 */
export interface PromoCodeChannelResolveContext {
  rewardCode?: string;
  trackerCode?: string;
  campaignCode?: string;
  tenantId?: number;
}

/** `018_create_promo_code_channel_config.ts`'s own column set, exactly — `restEnabled`/
 * `grpcEnabled` are never collapsed into `primaryChannel`/`fallbackChannel`: a channel can be the
 * configured `primary_channel` yet still be individually disabled (TC-3), and the caller needs both
 * pieces of information independently. */
export interface ResolvedPromoCodeChannel {
  primaryChannel: PromoCodeChannel;
  fallbackChannel: PromoCodeChannel;
  restEnabled: boolean;
  grpcEnabled: boolean;
  /** T-RR-081, migration `019`. */
  kafkaEnabled: boolean;
}

/** Thrown instead of returning a hardcoded default when no row resolves at any scope, including no
 * `GLOBAL` row — migration `018` seeds exactly one `GLOBAL` row, but this resolver must not assume
 * that seed survives a fresh/misconfigured environment. The caller decides how to handle this
 * failure; this resolver's own job is to fail loudly, never guess (same precedent as
 * `DispatchChannelResolutionError`, T-RR-033). */
export class PromoCodeChannelResolutionError extends Error {
  constructor(context: PromoCodeChannelResolveContext) {
    super(
      'No promo_code_channel_config row resolved at any scope (REWARD, TRACKER, CAMPAIGN or ' +
        `GLOBAL) for context ${JSON.stringify(context)} — the GLOBAL row itself is missing or ` +
        'unreachable.',
    );
    this.name = 'PromoCodeChannelResolutionError';
  }
}

/** `IS NOT DISTINCT FROM` (rather than `=`) is required on both nullable columns — a `GLOBAL`
 * row's `scope_ref_code` is `NULL` by definition, and a tenant-agnostic row at any scope has
 * `tenant_id IS NULL`; plain `=` against a bound `NULL` parameter is SQL `UNKNOWN`, never `TRUE`.
 * Same reasoning as `dispatch-channel-config.repository.ts`'s own `FIND_ONE_SQL`. */
const FIND_ONE_SQL = `
  SELECT * FROM reward_redemption.promo_code_channel_config
  WHERE scope_level = $1
    AND scope_ref_code IS NOT DISTINCT FROM $2
    AND tenant_id IS NOT DISTINCT FROM $3
`;

function toResolved(row: PromoCodeChannelConfigRow): ResolvedPromoCodeChannel {
  return {
    primaryChannel: row.primary_channel,
    fallbackChannel: row.fallback_channel,
    restEnabled: row.rest_enabled,
    grpcEnabled: row.grpc_enabled,
    // T-RR-081, migration `019`.
    kafkaEnabled: row.kafka_enabled,
  };
}

/** One scope level to try, paired with the ref code that level resolves on (`null` for `GLOBAL`,
 * whose `scope_ref_code` is `NULL` by definition). */
interface Candidate {
  level: PromoCodeChannelScopeLevel;
  refCode: string | null;
}

@Injectable()
export class PromoCodeChannelResolverService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(config: ConfigService<Config, true>, @Optional() pool?: Pool) {
    this.pool =
      pool ??
      new Pool({
        host: config.get('DB_HOST', { infer: true }),
        port: config.get('DB_PORT', { infer: true }),
        database: config.get('DB_NAME', { infer: true }),
        user: config.get('DB_APP_USERNAME', { infer: true }),
        password: config.get('DB_APP_PASSWORD', { infer: true }),
        ssl: config.get('DB_SSL', { infer: true }) ? { rejectUnauthorized: false } : undefined,
      });
  }

  async resolve(context: PromoCodeChannelResolveContext): Promise<ResolvedPromoCodeChannel> {
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
      const row = await this.resolveAtLevel(level, refCode, tenantId);
      if (row) {
        return toResolved(row);
      }
    }

    throw new PromoCodeChannelResolutionError(context);
  }

  /** Within one scope level, a tenant-specific row (`tenant_id` bound to the caller's own
   * `tenantId`) wins over the tenant-agnostic row (`tenant_id IS NULL`) at that *same* level —
   * checked before falling through to the next scope level entirely, never after (same TC-5
   * precedent as `DispatchChannelResolverService`). */
  private async resolveAtLevel(
    level: PromoCodeChannelScopeLevel,
    refCode: string | null,
    tenantId: number | null,
  ): Promise<PromoCodeChannelConfigRow | null> {
    if (tenantId !== null) {
      const tenantSpecific = await this.findOne(level, refCode, tenantId);
      if (tenantSpecific) {
        return tenantSpecific;
      }
    }
    return this.findOne(level, refCode, null);
  }

  private async findOne(
    scopeLevel: PromoCodeChannelScopeLevel,
    scopeRefCode: string | null,
    tenantId: number | null,
  ): Promise<PromoCodeChannelConfigRow | null> {
    const result = await this.pool.query<PromoCodeChannelConfigRow>(FIND_ONE_SQL, [
      scopeLevel,
      scopeRefCode,
      tenantId,
    ]);
    return result.rows[0] ?? null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
