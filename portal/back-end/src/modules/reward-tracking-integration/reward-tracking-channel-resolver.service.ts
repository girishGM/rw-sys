/**
 * T-INT-030 — `RewardTrackingChannelResolverService`, the REST-vs-gRPC precedence walk over
 * `reward_portal.reward_tracking_channel_config` (migration `T172_001`). Ported in *shape* from
 * `PromoCodeChannelResolverService`
 * (`reward-redemption-service/src/modules/connectors/promo-code-channel-resolver.service.ts`,
 * T-RR-080) — same `REWARD → TRACKER → CAMPAIGN → GLOBAL` first-match-wins walk, same
 * tenant-specific-before-tenant-agnostic rule at each level — adapted to this portal's own idiom:
 * the shared `Sequelize` connection (`SEQUELIZE`, the same convention
 * `message.repository.ts`/`permission.repository.ts` already use), not a dedicated `pg.Pool`.
 * Matching `reward-service-integration-plan/AGENT-PROTOCOL.md` §3 ("match each service's own
 * surrounding style ... do not import one service's conventions into another's codebase just
 * because you're editing both in the same task").
 *
 * ### Deliberately not cached — a disclosed scope decision, not a silent deviation
 *
 * `ARCHITECTURE.md` §4's general pattern is a TTL cache plus a shared
 * `POST /api/v1/cache/invalidate` endpoint. This resolver skips both, for two reasons:
 *
 *  1. This leg's call volume is bounded by how often an admin opens a dashboard — nowhere near
 *     RR's own per-redemption hot path that pattern was built for (the same volume argument
 *     `PromoCodeChannelResolverService`'s own header makes for staying uncached, even though that
 *     one additionally has a money-bearing-decision reason this leg does not).
 *  2. A shared cache-invalidate endpoint is not in this task's own "Files owned" list, and
 *     building one — a new, general-purpose portal surface future legs would also want to
 *     register against — is scope this task does not need to take on to satisfy its own DoD.
 *
 * `set-transport-primary.js`'s own registry entry for this leg still names a cache key
 * (`rewardTrackingChannel`) for forward compatibility; until a cache exists, that script's own
 * invalidate POST simply finds no live endpoint to hit and warns — a case its own `runDbLeg`
 * already handles gracefully ("restart ... to be sure"). The DB write itself is always live
 * immediately, since every `resolve()` call here reads the row fresh. Flagged in this task's
 * completion report.
 */
import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';

export type RewardTrackingChannel = 'REST' | 'GRPC';
export type RewardTrackingChannelScopeLevel = 'REWARD' | 'TRACKER' | 'CAMPAIGN' | 'GLOBAL';

/** Every field is a *code* value or the `tenant_id` int this portal's own tables already carry —
 * never another service's internal id, mirroring `PromoCodeChannelResolveContext`'s own
 * convention. A field left `undefined` means that scope level can never match. None of this leg's
 * current callers populate `rewardCode`/`trackerCode` (the RTS admin-rewards API has no reward- or
 * tracker-level granularity), but the shape is kept identical to every other leg's resolve context
 * so a future per-campaign override needs no schema change. */
export interface RewardTrackingChannelResolveContext {
  readonly rewardCode?: string;
  readonly trackerCode?: string;
  readonly campaignCode?: string;
  readonly tenantId?: number;
}

/** `T172_001`'s own column set, exactly. `restEnabled`/`grpcEnabled` are never collapsed into
 * `primaryChannel`/`fallbackChannel`: a channel can be the configured `primary_channel` yet still
 * be individually disabled, and the caller needs both pieces of information independently. */
export interface ResolvedRewardTrackingChannel {
  readonly primaryChannel: RewardTrackingChannel;
  readonly fallbackChannel: RewardTrackingChannel;
  readonly restEnabled: boolean;
  readonly grpcEnabled: boolean;
}

/** Thrown instead of guessing a default when no row resolves at any scope, including the seeded
 * `GLOBAL` row being missing from a misconfigured/fresh environment. Same precedent as
 * `PromoCodeChannelResolutionError` — fail loudly, never guess. */
export class RewardTrackingChannelResolutionError extends Error {
  constructor(context: RewardTrackingChannelResolveContext) {
    super(
      'No reward_tracking_channel_config row resolved at any scope (REWARD, TRACKER, CAMPAIGN or ' +
        `GLOBAL) for context ${JSON.stringify(context)} — the GLOBAL row itself is missing or ` +
        'unreachable.',
    );
    this.name = 'RewardTrackingChannelResolutionError';
  }
}

interface RewardTrackingChannelConfigRow {
  primary_channel: RewardTrackingChannel;
  fallback_channel: RewardTrackingChannel;
  rest_enabled: boolean;
  grpc_enabled: boolean;
}

/** One scope level to try, paired with the ref code that level resolves on (`null` for `GLOBAL`,
 * whose `scope_ref_code` is `NULL` by definition). */
interface Candidate {
  level: RewardTrackingChannelScopeLevel;
  refCode: string | null;
}

function toResolved(row: RewardTrackingChannelConfigRow): ResolvedRewardTrackingChannel {
  return {
    primaryChannel: row.primary_channel,
    fallbackChannel: row.fallback_channel,
    restEnabled: row.rest_enabled,
    grpcEnabled: row.grpc_enabled,
  };
}

@Injectable()
export class RewardTrackingChannelResolverService {
  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  async resolve(
    context: RewardTrackingChannelResolveContext = {},
  ): Promise<ResolvedRewardTrackingChannel> {
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

    throw new RewardTrackingChannelResolutionError(context);
  }

  /** Within one scope level, a tenant-specific row wins over the tenant-agnostic row at that
   * *same* level — checked before falling through to the next scope level entirely, never after
   * (same precedent as `PromoCodeChannelResolverService#resolveAtLevel`). */
  private async resolveAtLevel(
    level: RewardTrackingChannelScopeLevel,
    refCode: string | null,
    tenantId: number | null,
  ): Promise<RewardTrackingChannelConfigRow | null> {
    if (tenantId !== null) {
      const tenantSpecific = await this.queryChannelConfigRow(level, refCode, tenantId);
      if (tenantSpecific) {
        return tenantSpecific;
      }
    }
    return this.queryChannelConfigRow(level, refCode, null);
  }

  /** Named `queryChannelConfigRow`, not `findOne` — this codebase's own `no-raw-model-access`
   * ESLint rule (`.eslintrc.cjs`, AGENT-PROTOCOL R2) matches on method **name** alone
   * (`CallExpression[callee.property.name=/^(findAll|findOne|...)$/]`), independent of the
   * receiver, specifically so a raw Sequelize model call cannot be renamed around the ban; a
   * private helper on this class happening to share that name would trip the same false
   * positive it also correctly catches everywhere else.
   *
   * `IS NOT DISTINCT FROM` (rather than `=`) is required on both nullable columns — a `GLOBAL`
   * row's `scope_ref_code` is `NULL` by definition, and a tenant-agnostic row at any scope has
   * `tenant_id IS NULL`; plain `=` against a bound `NULL` parameter is SQL `UNKNOWN`, never
   * `TRUE`. Same reasoning as `PromoCodeChannelResolverService`'s own `FIND_ONE_SQL`. */
  private async queryChannelConfigRow(
    level: RewardTrackingChannelScopeLevel,
    refCode: string | null,
    tenantId: number | null,
  ): Promise<RewardTrackingChannelConfigRow | null> {
    const rows = await this.sequelize.query<RewardTrackingChannelConfigRow>(
      `
      SELECT primary_channel, fallback_channel, rest_enabled, grpc_enabled
        FROM reward_portal.reward_tracking_channel_config
       WHERE scope_level = :level
         AND scope_ref_code IS NOT DISTINCT FROM :refCode
         AND tenant_id IS NOT DISTINCT FROM :tenantId
      `,
      { type: QueryTypes.SELECT, replacements: { level, refCode, tenantId } },
    );
    return rows[0] ?? null;
  }
}
