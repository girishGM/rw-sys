/**
 * T-RAP-033. The budget/customer-limit enforcement engine — `05-PROCESSING-PIPELINE.md` §6's own
 * implementation, in full. Called from the extension point `rule-evaluation-row-handler.service.ts`
 * marks (T-RAP-031/032), still inside that same transaction/advisory-lock scope, once a tracker
 * component's completion makes a reward eligible.
 *
 * For every `BoundReward` assignment bound to the completion, and every `CampaignCap` that matches
 * it (`project-plan/11-BUDGETS-AND-LIMITS.md` §3.1's own matching rule): `SELECT ... FOR UPDATE`
 * the matching consumption row (`budget_consumption` for `cap_class = 'budget'`,
 * `customer_reward_limit_consumption` for `'limit'`), compare against the cap's ceiling, and
 * either reserve (increment) or deny — independently per assignment (§6 point 2: "a different
 * assignment on the same completion is evaluated independently — one failing cap does not block a
 * sibling assignment").
 *
 * **Two flagged deviations, both explained in full where they're implemented and summarized in
 * this task's completion report:**
 *  - `deriveCapKey` below — `CampaignCap` carries no numeric id to key `budget_consumption`/
 *    `customer_reward_limit_consumption`'s `reward_policy_code`/`cap_type` columns with.
 *  - `resolveFixedRewardValue` below — no design doc in this plan specifies `BoundReward
 *    .policies_json`'s schema, so a reward's earned *value* (needed for the amount-based check)
 *    has no specified resolution path; this is this task's own narrow, best-effort interpretation.
 *
 * **T-RAP-059 update:** `handleBreach`'s two log lines now go through `StructuredLogger`
 * (correlationId/tenantId/campaignCode as separate fields, `06-CONFIGURABILITY-AND-OBSERVABILITY.md`
 * §3) instead of the plain Nest `Logger` this file used before — `CapEnforcementContext` grew a
 * `correlationId` field purely to carry that value in, since this service otherwise has no
 * per-activity identifier of its own. `budget_breach_total{campaign_code,cap_type}` itself is
 * incremented by the *caller* (`rule-evaluation-row-handler.service.ts`'s `handle()`), reading
 * `cap_type` off this file's own `deriveCapKey` — not duplicated here, so there is exactly one
 * place that decides what `cap_type` means for a given `CampaignCap`.
 */
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import type {
  BoundRewardProto,
  CampaignCapProto,
} from '@/modules/campaign-cache/campaign-config.client';
import { StructuredLogger, StructuredLoggerFactory } from '@/observability/structured-logger';
import { BudgetConsumptionRepository } from './budget-consumption.repository';
import { CustomerLimitConsumptionRepository } from './customer-limit-consumption.repository';
import { computePeriodBucket } from './period-bucket.util';
import { BudgetBreachCallbackClient } from './budget-breach-callback.client';

export interface CapEnforcementContext {
  /** T-RAP-059: threaded through purely so this service's own `StructuredLogger` calls carry the
   * same correlationId as every other log line concerning this activity
   * (06-CONFIGURABILITY-AND-OBSERVABILITY.md §4) — never used for any business decision here. */
  correlationId: string;
  tenantId: number;
  /** The portal's own numeric campaign id — needed only for the `pause_campaign` REST callback
   * path (`BudgetBreachCallbackClient`), never for local bookkeeping (which is keyed by
   * `campaignCode`, this service's own convention throughout). */
  campaignId: number;
  campaignCode: string;
  customerIdHash: string;
  /** The tracker the completing component belongs to — needed to decide whether a tracker-scoped
   * cap covers a component-level reward assignment (`matchCapsForAssignment`'s own header). */
  trackerId: number;
  /** `reward_entry_date` — computed once by the caller, passed through, never re-read mid-
   * transaction (`05-PROCESSING-PIPELINE.md` §6 point 2). */
  rewardEntryDate: Date;
  assignments: readonly BoundRewardProto[];
  /** The full, cached `CampaignConfig.caps` list for this campaign — filtered down to the caps
   * that actually apply to each assignment by `matchCapsForAssignment` below (implementation
   * note 5: "caps arrive already fully resolved ... use the cached cap values as-is"). */
  caps: readonly CampaignCapProto[];
}

export interface GrantedAssignment {
  reward: BoundRewardProto;
  /** Decimal-as-string, resolved by `resolveFixedRewardValue` — T-RAP-034's own `reward_entry`
   * insert reuses this value rather than re-resolving it. */
  rewardValue: string;
}

export interface DeniedAssignment {
  reward: BoundRewardProto;
  cap: CampaignCapProto;
  /** Names the specific cap and its current-vs-limit numbers — this is what
   * `activity_logs.comment` surfaces (implementation note 4). */
  comment: string;
}

export interface CapEnforcementOutcome {
  granted: GrantedAssignment[];
  denied: DeniedAssignment[];
}

interface BreachDetail {
  dimension: 'amount' | 'count';
  current: string;
  attempted: string;
  max: string;
  observedTotal: string;
}

const DECIMAL_SCALE = 1_000_000n; // 6 decimal places — headroom over decimal(18,4)'s own 4.

function toScaledBigInt(value: string): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal string "${value}"`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart, fractionPart = ''] = unsigned.split('.');
  const fraction = `${fractionPart}000000`.slice(0, 6);
  const scaled = BigInt(wholePart) * DECIMAL_SCALE + BigInt(fraction);
  return negative ? -scaled : scaled;
}

function fromScaledBigInt(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / DECIMAL_SCALE;
  const fractionDigits = (abs % DECIMAL_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fractionDigits === '' ? '' : `.${fractionDigits}`}`;
}

function addDecimalStrings(a: string, b: string): string {
  return fromScaledBigInt(toScaledBigInt(a) + toScaledBigInt(b));
}

function compareDecimalStrings(a: string, b: string): number {
  const diff = toScaledBigInt(a) - toScaledBigInt(b);
  return diff > 0n ? 1 : diff < 0n ? -1 : 0;
}

/**
 * `CampaignCap` (the real, confirmed, cached shape) carries no numeric id — unlike
 * `BudgetStatusEntry.cap_id` on the portal's own separate `GetBudgetStatus` RPC,
 * `CampaignConfig.caps` (what this service actually caches) has nothing the
 * `budget_consumption`/`customer_reward_limit_consumption` tables' `reward_policy_code`/
 * `cap_type` columns (`01-DATABASE.md` §6, predating this confirmed shape) were designed to hold.
 *
 * This derives a stable identity instead, from exactly the fields the portal's own
 * `campaign_caps` table uses for *its* uniqueness constraint
 * (`project-plan/11-BUDGETS-AND-LIMITS.md` §2's `uq_cc_unique`/`dedupe_key`) — the same real cap
 * always produces the same pair; two different real caps produce different pairs (a SHA-256
 * digest of the full discriminating tuple, so no `varchar(30)`/`varchar(80)` length limit is ever
 * at risk of truncating two distinct caps onto the same value). `cap_type` carries the
 * human-readable `cap_class` (`'budget'|'limit'`); `reward_policy_code` carries the full digest —
 * the pair together, not `cap_type` alone, is what the unique index relies on for uniqueness.
 *
 * Flagged in the completion report: the cleaner fix is renaming these two columns to match the
 * real discriminators (`cap_class`/`scope_level`/`scope_ref_id`/`period_type`/`unit_type`/
 * `unit_code`/`reward_type`) — out of this task's own file scope (`src/database/**` is
 * `agent-rap-foundation`'s), a candidate follow-up for the architect to schedule.
 */
export function deriveCapKey(cap: CampaignCapProto): { rewardPolicyCode: string; capType: string } {
  const discriminator = [
    cap.capClass,
    cap.scopeLevel,
    cap.scopeRefId,
    cap.periodType,
    cap.periodValue,
    cap.windowStartTime,
    cap.windowEndTime,
    cap.unitType,
    cap.unitCode,
    cap.rewardType,
  ].join('|');
  const digest = createHash('sha256').update(discriminator).digest('hex').slice(0, 40);
  return { rewardPolicyCode: digest, capType: cap.capClass };
}

/**
 * `project-plan/11-BUDGETS-AND-LIMITS.md` §3.1's own matching rule: a cap `C` governs a reward
 * grant `G` when `C.unit_type/unit_code` matches `G`'s (rule 2), `C.reward_type` is unset or
 * matches `G`'s (rule 3), and `C`'s scope covers where `G` attaches (rule 1) — a campaign-scope
 * cap covers every reward in the campaign; a tracker-scope cap covers a reward at that same
 * tracker or at any component within it; a component-scope cap covers only a reward at that exact
 * component.
 */
export function matchCapsForAssignment(
  reward: BoundRewardProto,
  trackerId: number,
  caps: readonly CampaignCapProto[],
): CampaignCapProto[] {
  return caps.filter((cap) => {
    if (cap.unitType !== reward.unitType || cap.unitCode !== reward.unitCode) {
      return false;
    }
    if (cap.rewardType && cap.rewardType !== reward.rewardType) {
      return false;
    }
    return capScopeCoversReward(cap, reward, trackerId);
  });
}

function capScopeCoversReward(
  cap: CampaignCapProto,
  reward: BoundRewardProto,
  trackerId: number,
): boolean {
  if (cap.scopeLevel === 'campaign') {
    return true;
  }
  if (cap.scopeLevel === 'tracker') {
    if (reward.level === 'tracker') {
      return cap.scopeRefId === reward.refId;
    }
    if (reward.level === 'component') {
      return cap.scopeRefId === trackerId;
    }
    return false;
  }
  if (cap.scopeLevel === 'component') {
    return reward.level === 'component' && cap.scopeRefId === reward.refId;
  }
  return false;
}

/**
 * No design doc in this plan specifies `BoundReward.policies_json`'s own schema (documented only
 * as "caps, rates — frozen at this version", `project-plan/09-INTEGRATION.md` §3) — resolving a
 * reward's *earned value* from an arbitrary rate/tier structure is a reward-calculation-engine
 * concern no task in this plan owns yet. This function is this task's own narrow, best-effort
 * interpretation: a fixed amount, read from `policies_json.fixedAmount` (or `.amount`) as a
 * decimal string — the simplest, most common shape, and the only one this task can verify against
 * a real fixture. Anything else (a rate off `activity_value`, a tiered schedule) throws a clear,
 * named error rather than silently guessing — `05-PROCESSING-PIPELINE.md` §3's own "a genuine
 * error ... the whole transaction rolls back ... safe to retry" applies here exactly as it does to
 * a malformed rule expression. **Flagged prominently in the completion report for architect
 * confirmation.**
 */
export function resolveFixedRewardValue(reward: BoundRewardProto): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reward.policiesJson || '{}');
  } catch {
    throw new Error(
      `BoundReward ${reward.rewardId} (version ${reward.rewardVersionId}) has unparseable ` +
        'policies_json — cannot resolve its reward value (resolveFixedRewardValue).',
    );
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(
      `BoundReward ${reward.rewardId} (version ${reward.rewardVersionId}) policies_json is not a ` +
        'JSON object.',
    );
  }
  const record = parsed as Record<string, unknown>;
  const candidate = record.fixedAmount ?? record.amount;
  if (typeof candidate !== 'string' && typeof candidate !== 'number') {
    throw new Error(
      `BoundReward ${reward.rewardId} (version ${reward.rewardVersionId}) policies_json has no ` +
        'resolvable "fixedAmount"/"amount" — this task\'s own reward-value resolution only ' +
        "supports a fixed amount (see resolveFixedRewardValue's own header for why).",
    );
  }
  const value = String(candidate);
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(
      `BoundReward ${reward.rewardId} policies_json "fixedAmount"/"amount" is not a valid ` +
        `non-negative decimal: ${JSON.stringify(candidate)}.`,
    );
  }
  return value;
}

/** Proto3 zero-values (`''`/`0`) mean "this ceiling is not configured"
 * (`11-BUDGETS-AND-LIMITS.md` §2: "at least one [ceiling] must be set" — never literally "spend
 * nothing"), so an unset dimension is skipped rather than treated as an always-breached zero
 * ceiling. Returns the breach detail for the *first* dimension that fails, or `null` if both
 * (configured) dimensions have headroom. */
function checkCeiling(
  cap: CampaignCapProto,
  consumedAmount: string,
  consumedCount: number,
  rewardValue: string,
): BreachDetail | null {
  if (cap.maxTotalAmount && cap.maxTotalAmount !== '0') {
    const nextAmount = addDecimalStrings(consumedAmount, rewardValue);
    if (compareDecimalStrings(nextAmount, cap.maxTotalAmount) > 0) {
      return {
        dimension: 'amount',
        current: consumedAmount,
        attempted: rewardValue,
        max: cap.maxTotalAmount,
        observedTotal: nextAmount,
      };
    }
  }
  if (cap.maxOccurrences && cap.maxOccurrences > 0) {
    const nextCount = consumedCount + 1;
    if (nextCount > cap.maxOccurrences) {
      return {
        dimension: 'count',
        current: String(consumedCount),
        attempted: '1',
        max: String(cap.maxOccurrences),
        observedTotal: String(nextCount),
      };
    }
  }
  return null;
}

@Injectable()
export class CapEnforcementService {
  private readonly structuredLogger: StructuredLogger;

  constructor(
    private readonly budgetRepository: BudgetConsumptionRepository,
    private readonly customerLimitRepository: CustomerLimitConsumptionRepository,
    private readonly breachCallback: BudgetBreachCallbackClient,
    loggers: StructuredLoggerFactory,
  ) {
    this.structuredLogger = loggers.forContext(CapEnforcementService.name);
  }

  /**
   * `05-PROCESSING-PIPELINE.md` §6, in full, for one tracker-component completion. Every
   * assignment is evaluated fully (reserved or denied) before moving to the next — sequential, not
   * concurrent, deliberately (§6 point 2: independent outcomes, but still one at a time within
   * this same transaction/advisory-lock scope).
   */
  async enforceForCompletion(
    transaction: Transaction,
    context: CapEnforcementContext,
  ): Promise<CapEnforcementOutcome> {
    const granted: GrantedAssignment[] = [];
    const denied: DeniedAssignment[] = [];

    for (const reward of context.assignments) {
      const outcome = await this.enforceOneAssignment(transaction, context, reward);
      if (outcome.granted) {
        granted.push({ reward, rewardValue: outcome.rewardValue });
      } else {
        denied.push(outcome.denial);
      }
    }

    return { granted, denied };
  }

  private async enforceOneAssignment(
    transaction: Transaction,
    context: CapEnforcementContext,
    reward: BoundRewardProto,
  ): Promise<
    { granted: true; rewardValue: string } | { granted: false; denial: DeniedAssignment }
  > {
    const rewardValue = resolveFixedRewardValue(reward);
    const matchedCaps = matchCapsForAssignment(reward, context.trackerId, context.caps);

    // Reserve-then-commit (`01-DATABASE.md` §6): every matched cap on this one assignment must
    // pass before *any* of them is incremented — a partial reservation followed by a later breach
    // on a sibling cap of the *same* assignment would overspend the caps that already passed.
    const reservations: Array<{
      table: 'budget' | 'limit';
      id: string;
      deltaAmount: string;
    }> = [];

    for (const cap of matchedCaps) {
      const { periodStart, periodEnd } = computePeriodBucket(cap, context.rewardEntryDate);
      const capKey = deriveCapKey(cap);

      if (cap.capClass === 'budget') {
        const row = await this.budgetRepository.lockOrCreate(transaction, {
          tenantId: context.tenantId,
          campaignCode: context.campaignCode,
          rewardPolicyCode: capKey.rewardPolicyCode,
          capType: capKey.capType,
          periodStart,
          periodEnd,
        });
        const breach = checkCeiling(cap, row.consumed_amount, row.consumed_count, rewardValue);
        if (breach !== null) {
          return { granted: false, denial: await this.handleBreach(context, reward, cap, breach) };
        }
        reservations.push({ table: 'budget', id: row.id, deltaAmount: rewardValue });
      } else if (cap.capClass === 'limit') {
        const row = await this.customerLimitRepository.lockOrCreate(transaction, {
          tenantId: context.tenantId,
          customerIdHash: context.customerIdHash,
          campaignCode: context.campaignCode,
          rewardPolicyCode: capKey.rewardPolicyCode,
          assignmentLevel: cap.scopeLevel as 'campaign' | 'tracker' | 'component',
          periodStart,
          periodEnd,
        });
        const breach = checkCeiling(cap, row.consumed_amount, row.consumed_count, rewardValue);
        if (breach !== null) {
          return { granted: false, denial: await this.handleBreach(context, reward, cap, breach) };
        }
        reservations.push({ table: 'limit', id: row.id, deltaAmount: rewardValue });
      } else {
        throw new Error(
          `Unsupported CampaignCap.cap_class "${cap.capClass}" (must be "budget" or "limit").`,
        );
      }
    }

    for (const reservation of reservations) {
      if (reservation.table === 'budget') {
        await this.budgetRepository.increment(
          transaction,
          reservation.id,
          reservation.deltaAmount,
          1,
        );
      } else {
        await this.customerLimitRepository.increment(
          transaction,
          reservation.id,
          reservation.deltaAmount,
          1,
        );
      }
    }

    return { granted: true, rewardValue };
  }

  /**
   * `05-PROCESSING-PIPELINE.md` §6 point 2's three `on_breach` behaviours. `reject`/`alert_only`
   * both deny locally with no portal call; `pause_campaign` additionally calls
   * `BudgetBreachCallbackClient`, best-effort (never lets a callback failure affect this
   * transaction's own outcome — implementation note 6).
   */
  private async handleBreach(
    context: CapEnforcementContext,
    reward: BoundRewardProto,
    cap: CampaignCapProto,
    breach: BreachDetail,
  ): Promise<DeniedAssignment> {
    const comment =
      `Reward "${reward.systemCode}" denied — ${cap.capClass}/${cap.scopeLevel} cap breach ` +
      `(${breach.dimension}: ${breach.current} + ${breach.attempted} > ${breach.max}, ` +
      `on_breach="${cap.onBreach}").`;
    this.structuredLogger.warn(comment, {
      correlationId: context.correlationId,
      tenantId: context.tenantId,
      campaignCode: context.campaignCode,
      capType: cap.capClass,
      rewardSystemCode: reward.systemCode,
    });

    if (cap.onBreach === 'pause_campaign') {
      await this.breachCallback
        .reportBreach({
          tenantId: context.tenantId,
          campaignId: context.campaignId,
          campaignCode: context.campaignCode,
          cap,
          observedTotal: breach.observedTotal,
          breachedAt: context.rewardEntryDate,
        })
        .catch((error: unknown) => {
          this.structuredLogger.error(
            `budget-breach callback failed for campaign ${context.campaignCode}: ` +
              `${(error as Error).message}`,
            {
              correlationId: context.correlationId,
              tenantId: context.tenantId,
              campaignCode: context.campaignCode,
            },
          );
        });
    }

    return { reward, cap, comment };
  }
}
