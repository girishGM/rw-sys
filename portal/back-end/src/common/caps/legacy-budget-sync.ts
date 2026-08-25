import type { Sequelize, Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';
import type {
  CapClass,
  OnBreach,
  PeriodType,
  ScopeLevel,
  UnitType,
} from '@/database/models/campaign-cap.model';

/**
 * Dual-write helper — 11-BUDGETS-AND-LIMITS.md §2, T-006 Implementation notes §4.
 *
 * `tenant_campaigns.budget_amount` / `budget_currency` predate `campaign_caps` and are
 * **kept and maintained**, not deprecated, so every existing consumer that still reads
 * those two legacy columns directly keeps working untouched. Writing a
 * `budget` / `campaign` / `lifetime` cap must therefore update both tables in the same
 * transaction: the new `campaign_caps` row (the source of truth going forward) and the
 * legacy pair (for backward compatibility). Neither write may survive without the other —
 * a `campaign_caps` row with no matching legacy update, or a legacy update with no
 * `campaign_caps` row, is a data-integrity bug this helper exists specifically to prevent.
 *
 * **DO NOT "clean this up" by dropping the legacy write once `campaign_caps` is fully
 * adopted.** Other services still read `tenant_campaigns.budget_amount` /
 * `budget_currency` directly (T-006 Implementation notes §4) — retiring those columns is a
 * cross-service migration with its own sign-off, not a portal-side refactor. If you are a
 * later agent reading this: leave the dual write in place unless a task file explicitly
 * authorises removing it.
 *
 * Written against raw, parameterised SQL rather than the `CampaignCap` /
 * `TenantCampaign` Sequelize models: `reward_config.tenant_campaigns` has no portal model
 * yet (T-003, which depends on this task, owns that), so there is nothing to call `.save()`
 * on for the legacy half of the write. This mirrors the same raw-SQL-through-`Sequelize`
 * convention every migration in `src/database/migrations` already uses, and continues to
 * work unchanged once T-003 lands (a future caller may pass any `Sequelize` instance that
 * can reach both tables — this file makes no assumption about which role connects it).
 */
export interface CampaignCapWriteInput {
  tenantId: number;
  campaignId: number;
  capClass: CapClass;
  scopeLevel: ScopeLevel;
  scopeRefId?: number | null;
  periodType: PeriodType;
  periodValue?: number | null;
  /** `HH:MM` or `HH:MM:SS`, time-of-day only. */
  windowStartTime?: string | null;
  windowEndTime?: string | null;
  /** Omit to let `trg_cc_default_timezone` (T006_001) fill it from the campaign's country. */
  periodTimezone?: string | null;
  unitType?: UnitType | null;
  unitCode?: string | null;
  rewardType?: string | null;
  /** Decimal as a string (e.g. `'500000.0000'`) — never a JS number. */
  maxTotalAmount?: string | null;
  maxOccurrences?: number | null;
  maxCustomers?: number | null;
  onBreach?: OnBreach;
  warnAtPercent?: number | null;
  createdBy: number;
}

export interface CampaignCapWriteResult {
  id: number;
  /** True when the legacy `tenant_campaigns.budget_amount` / `budget_currency` pair was
   * also updated in this same transaction. */
  legacySynced: boolean;
}

/**
 * The one cap shape with a legacy equivalent: a **budget**, at **campaign** scope, for the
 * campaign's **lifetime**, denominated in **currency** — exactly what
 * `tenant_campaigns.budget_currency` (a 3-character legacy currency column) can represent.
 * A points or voucher lifetime budget has no legacy column to sync into — `unit_code`
 * for those units is not a currency and writing it into `budget_currency` would silently
 * mislabel the legacy column, so only `unitType === 'currency'` rows are dual-written.
 * Every other shape (limits, tracker/component scope, daily/monthly/rolling/time-of-day
 * periods, non-currency units) is `campaign_caps`-only, exactly as the design intends.
 */
export function isLegacyBudgetShape(
  input: Pick<CampaignCapWriteInput, 'capClass' | 'scopeLevel' | 'periodType' | 'unitType'>,
): boolean {
  return (
    input.capClass === 'budget' &&
    input.scopeLevel === 'campaign' &&
    input.periodType === 'lifetime' &&
    input.unitType === 'currency'
  );
}

/**
 * Inserts a `campaign_caps` row and, only for `isLegacyBudgetShape(input)`, updates
 * `tenant_campaigns.budget_amount` / `budget_currency` for the same campaign — both inside
 * one transaction, committed or rolled back together. `dedupe_key` is never supplied: it is
 * `GENERATED ALWAYS AS (...) STORED` in the database (T006_001) and Postgres rejects any
 * INSERT that tries to write it explicitly.
 */
export async function writeCampaignCapWithLegacySync(
  sequelize: Sequelize,
  input: CampaignCapWriteInput,
): Promise<CampaignCapWriteResult> {
  const legacySync = isLegacyBudgetShape(input);
  if (legacySync && !input.maxTotalAmount) {
    throw new Error(
      'A campaign/lifetime/currency budget must carry maxTotalAmount to sync tenant_campaigns.budget_amount',
    );
  }

  const t: Transaction = await sequelize.transaction();
  try {
    const [row] = await sequelize.query<{ id: number }>(
      `INSERT INTO reward_config.campaign_caps
         (tenant_id, campaign_id, cap_class, scope_level, scope_ref_id, period_type,
          period_value, window_start_time, window_end_time, period_timezone,
          unit_type, unit_code, reward_type, max_total_amount, max_occurrences,
          max_customers, on_breach, warn_at_percent, created_by)
       VALUES
         (:tenantId, :campaignId, :capClass, :scopeLevel, :scopeRefId, :periodType,
          :periodValue, :windowStartTime, :windowEndTime, :periodTimezone,
          :unitType, :unitCode, :rewardType, :maxTotalAmount, :maxOccurrences,
          :maxCustomers, :onBreach, :warnAtPercent, :createdBy)
       RETURNING id`,
      {
        replacements: {
          tenantId: input.tenantId,
          campaignId: input.campaignId,
          capClass: input.capClass,
          scopeLevel: input.scopeLevel,
          scopeRefId: input.scopeRefId ?? null,
          periodType: input.periodType,
          periodValue: input.periodValue ?? null,
          windowStartTime: input.windowStartTime ?? null,
          windowEndTime: input.windowEndTime ?? null,
          periodTimezone: input.periodTimezone ?? null,
          unitType: input.unitType ?? null,
          unitCode: input.unitCode ?? null,
          rewardType: input.rewardType ?? null,
          maxTotalAmount: input.maxTotalAmount ?? null,
          maxOccurrences: input.maxOccurrences ?? null,
          maxCustomers: input.maxCustomers ?? null,
          onBreach: input.onBreach ?? 'reject',
          warnAtPercent: input.warnAtPercent ?? null,
          createdBy: input.createdBy,
        },
        type: QueryTypes.SELECT,
        transaction: t,
      },
    );

    if (legacySync) {
      await sequelize.query(
        `UPDATE reward_config.tenant_campaigns
            SET budget_amount = :amount, budget_currency = :currency, updated_at = now()
          WHERE id = :campaignId`,
        {
          replacements: {
            amount: input.maxTotalAmount,
            currency: input.unitCode ?? null,
            campaignId: input.campaignId,
          },
          type: QueryTypes.UPDATE,
          transaction: t,
        },
      );
    }

    await t.commit();
    return { id: row.id, legacySynced: legacySync };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
