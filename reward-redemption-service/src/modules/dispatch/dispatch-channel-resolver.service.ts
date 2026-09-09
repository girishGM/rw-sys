import { Injectable } from '@nestjs/common';
import type {
  DispatchChannel,
  DispatchChannelConfigRow,
  DispatchScopeLevel,
} from '@/database/models/dispatch-channel-config.model';
import { DispatchChannelConfigCache } from './dispatch-channel-config.cache';

/**
 * T-RR-033. What a caller (T-RR-034/T-RR-035) supplies to resolve which channel(s) should carry
 * `reward.redemption.completed.v1` onward. Every field is a *code* value (R5) or the `tenant_id`
 * int this service's own tables already carry elsewhere (`reward_redemption_entry.tenant_id`) —
 * never another service's internal id. A field left `undefined` simply means that scope level can
 * never match (mirrors `ServiceConfigScopeContext`'s own convention, T-RR-006).
 */
export interface DispatchChannelResolveContext {
  rewardCode?: string;
  trackerCode?: string;
  campaignCode?: string;
  tenantId?: number;
}

/**
 * `01-DATABASE.md` §5's own column set, exactly — `kafkaEnabled`/`restEnabled`/`grpcEnabled` are
 * never collapsed into `primaryChannel`/`fallbackChannel` (implementation note 5): a channel can be
 * the configured `primary_channel` yet still be individually disabled, and the caller needs both
 * pieces of information independently.
 *
 * `grpcEnabled` added by T-RR-062 — sibling to `kafkaEnabled`/`restEnabled`, same shape, same
 * "individually disabled" independence.
 */
export interface ResolvedDispatchChannel {
  primaryChannel: DispatchChannel;
  fallbackChannel: DispatchChannel;
  kafkaEnabled: boolean;
  restEnabled: boolean;
  grpcEnabled: boolean;
}

/** TC-8. Thrown instead of returning a hardcoded default when no row resolves at any scope,
 * including no `GLOBAL` row — `01-DATABASE.md` §5 expects exactly one `GLOBAL` row to always
 * exist, but this resolver must not assume that seed survives a fresh/misconfigured environment.
 * The caller (T-RR-034) decides how to handle this failure; this resolver's own job is to fail
 * loudly, never guess. */
export class DispatchChannelResolutionError extends Error {
  constructor(context: DispatchChannelResolveContext) {
    super(
      'No dispatch_channel_config row resolved at any scope (REWARD, TRACKER, CAMPAIGN or ' +
        `GLOBAL) for context ${JSON.stringify(context)} — the GLOBAL row itself is missing or ` +
        'unreachable.',
    );
    this.name = 'DispatchChannelResolutionError';
  }
}

function toResolved(row: DispatchChannelConfigRow): ResolvedDispatchChannel {
  return {
    primaryChannel: row.primary_channel,
    fallbackChannel: row.fallback_channel,
    kafkaEnabled: row.kafka_enabled,
    restEnabled: row.rest_enabled,
    // T-RR-062: `grpc_enabled` is typed optional on the row (`dispatch-channel-config.model.ts`'s
    // own header) purely so out-of-scope hand-built test literals that predate this column still
    // compile — every real row from Postgres always has a real `boolean` here (`DEFAULT false`).
    // `?? false` reproduces that same safe default for the rare literal that omits it.
    grpcEnabled: row.grpc_enabled ?? false,
  };
}

/** One scope level to try, paired with the ref code that level resolves on (`null` for `GLOBAL`,
 * whose `scope_ref_code` is `NULL` by definition). */
interface Candidate {
  level: DispatchScopeLevel;
  refCode: string | null;
}

/**
 * `DispatchChannelResolverService` — the first-match-wins precedence walk
 * `REWARD → TRACKER → CAMPAIGN → GLOBAL` (`ARCHITECTURE.md` §9, `01-DATABASE.md` §5) over
 * `dispatch_channel_config`, ported in *shape* (not code) from `ServiceConfigResolverService`'s
 * own precedence-walk pattern (T-RR-006, implementation note 2): this table has a different scope
 * vocabulary (`REWARD`/`TRACKER`/`CAMPAIGN`/`GLOBAL`, not `CAMPAIGN`/`TENANT`/`COUNTRY`/`GLOBAL`)
 * and its own tenant-override axis (implementation note 1) on top.
 *
 * Resolution is strictly first-match, never a field-by-field merge across levels (implementation
 * note 1's explicit "do not implement this as 'merge all matching rows'"): the first scope level
 * with *any* matching row — tenant-specific preferred over tenant-agnostic at that same level
 * (TC-5) — wins outright, and every field of `ResolvedDispatchChannel` comes from that one row.
 */
@Injectable()
export class DispatchChannelResolverService {
  constructor(private readonly cache: DispatchChannelConfigCache) {}

  async resolve(context: DispatchChannelResolveContext): Promise<ResolvedDispatchChannel> {
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

    throw new DispatchChannelResolutionError(context);
  }

  /** TC-5: within one scope level, a tenant-specific row (`tenant_id` bound to the caller's own
   * `tenantId`) wins over the tenant-agnostic row (`tenant_id IS NULL`) at that *same* level —
   * checked before falling through to the next scope level entirely, never after. */
  private async resolveAtLevel(
    level: DispatchScopeLevel,
    refCode: string | null,
    tenantId: number | null,
  ): Promise<DispatchChannelConfigRow | null> {
    if (tenantId !== null) {
      const tenantSpecific = await this.cache.lookup(level, refCode, tenantId);
      if (tenantSpecific) {
        return tenantSpecific;
      }
    }
    return this.cache.lookup(level, refCode, null);
  }
}
