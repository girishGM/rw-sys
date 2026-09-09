/**
 * T-RTS-030. The **one** shared function every customer-facing endpoint in this task — and every
 * portal-admin endpoint T-RTS-031 later adds — calls to turn a `reward_kind`-grouped/summed row into
 * the correctly-shaped response object, per `brain-storm/04-API-DESIGN.md` §0's pseudocode
 * (AGENT-PROTOCOL.md R4). One function, one place the rule can ever be wrong, one place to fix it —
 * never reimplemented per endpoint.
 *
 * **The rule, verbatim from doc 04 §0:**
 * ```
 * for each grouped row:
 *   if reward_kind in ('FIXED_AMOUNT', 'POINTS'):
 *       emit { rewardCategory, rewardKind, totalValue, totalCount, unitType, unitCode }
 *   elif reward_kind in ('PERCENTAGE', 'PHYSICAL', 'PROMO_CODE'):
 *       emit { rewardCategory, rewardKind, totalCount }              # no totalValue field at all
 *       # optionally: averageRatePercent = AVG(reward_value) for PERCENTAGE;
 *       # for PROMO_CODE, promoCodeConfigId/promoCodeConfigVersionNo instead — never summed
 *   elif reward_kind is null (today's actual state):
 *       emit { rewardCategory, rewardKind: null, totalCount }        # conservative: non-summable
 * ```
 * `totalValue` (and `unitType`/`unitCode`, per doc 04 §1.1's own worked example — the `PERCENTAGE`
 * row there carries neither) are **never present at all** on a non-summable row — not `null`, not a
 * fabricated `"0.0000"` — literally absent from the returned object, so `JSON.stringify` never
 * serializes a key a client could mistake for a real total (R4).
 *
 * **`averageRatePercent` is computed here, not passed in as a separate precomputed SQL column.**
 * doc 04 §0's own pseudocode computes it as `AVG(reward_value)` over the group; since `totalValue`
 * already carries `SUM(reward_value)` and `totalCount` already carries the row count for that exact
 * same group (true for both a single ungrouped ledger row — count always 1 — and a real `GROUP BY`
 * rollup), `totalValue / totalCount` is arithmetically identical to `AVG(reward_value)` for every
 * caller in this task, without needing a second SQL expression duplicated across every query. Kept as
 * a two-decimal-place string, matching doc 04's own `"10.00"` worked example precisely.
 */
import type { RewardKind } from '@/database/models/reward-fact.model';

/** The only two kinds whose `reward_value` (and therefore whose `SUM`) is ever a real, additive
 * amount — `brain-storm/02-DATA-MODEL.md` §2.2, AGENT-PROTOCOL.md R4. Every other kind, including
 * `null`, is treated as non-summable. */
export const SUMMABLE_REWARD_KINDS: ReadonlySet<RewardKind> = new Set(['FIXED_AMOUNT', 'POINTS']);

export function isSummableRewardKind(
  rewardKind: RewardKind | null,
): rewardKind is 'FIXED_AMOUNT' | 'POINTS' {
  return rewardKind !== null && SUMMABLE_REWARD_KINDS.has(rewardKind);
}

/**
 * What every caller in this task already has on hand, straight off a `customer_reward_ledger` row
 * (grouped or not) — `totalValue`/`totalCount` are always supplied (the storage layer never refuses
 * to hold a non-summable value, per §2.2), this function is the one place that decides whether they
 * ever reach a response. `promoCodeConfigId`/`promoCodeConfigVersionNo` are `PROMO_CODE`-only,
 * audit/display fields copied verbatim from the originating row (§2.3) — never read for any other
 * kind, never summed.
 */
export interface RewardGroupInput {
  rewardCategory: string;
  rewardKind: RewardKind | null;
  unitType?: string | null;
  unitCode?: string | null;
  /** Raw stored/summed value — meaningful only when {@link isSummableRewardKind} is true for the
   * same row's `rewardKind` (§2.2/§3.1). Always a numeric string (`pg`'s own `decimal` wire format). */
  totalValue: string;
  totalCount: number;
  promoCodeConfigId?: string | null;
  promoCodeConfigVersionNo?: number | null;
}

export interface SummableRewardGroup {
  rewardCategory: string;
  rewardKind: 'FIXED_AMOUNT' | 'POINTS';
  unitType: string | null;
  unitCode: string | null;
  totalValue: string;
  totalCount: number;
}

export interface NonSummableRewardGroup {
  rewardCategory: string;
  rewardKind: RewardKind | null;
  totalCount: number;
  averageRatePercent?: string;
  promoCodeConfigId?: string;
  promoCodeConfigVersionNo?: number;
}

export type ShapedRewardGroup = SummableRewardGroup | NonSummableRewardGroup;

/**
 * The one function (R4/AGENT-PROTOCOL). Never mutates `input`; always returns a fresh object whose
 * own key set already reflects the presence/absence rule — callers never need a second conditional
 * to decide whether to serialize `totalValue`.
 */
export function shapeRewardGroup(input: RewardGroupInput): ShapedRewardGroup {
  if (isSummableRewardKind(input.rewardKind)) {
    const summable: SummableRewardGroup = {
      rewardCategory: input.rewardCategory,
      rewardKind: input.rewardKind,
      unitType: input.unitType ?? null,
      unitCode: input.unitCode ?? null,
      totalValue: input.totalValue,
      totalCount: input.totalCount,
    };
    return summable;
  }

  const shaped: NonSummableRewardGroup = {
    rewardCategory: input.rewardCategory,
    rewardKind: input.rewardKind,
    totalCount: input.totalCount,
  };

  if (input.rewardKind === 'PERCENTAGE' && input.totalCount > 0) {
    const average = Number(input.totalValue) / input.totalCount;
    if (Number.isFinite(average)) {
      shaped.averageRatePercent = average.toFixed(2);
    }
  }

  if (input.rewardKind === 'PROMO_CODE') {
    if (input.promoCodeConfigId !== undefined && input.promoCodeConfigId !== null) {
      shaped.promoCodeConfigId = input.promoCodeConfigId;
    }
    if (input.promoCodeConfigVersionNo !== undefined && input.promoCodeConfigVersionNo !== null) {
      shaped.promoCodeConfigVersionNo = input.promoCodeConfigVersionNo;
    }
  }

  return shaped;
}
