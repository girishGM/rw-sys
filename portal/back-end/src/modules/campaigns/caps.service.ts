/**
 * T-037 step 6 — `GET`/`PUT /campaigns/:id/caps` (11-BUDGETS-AND-LIMITS.md §6).
 *
 * ### Replace, in one transaction
 *
 * Step 6 is one screen the maker edits as a unit, and `uq_cc_unique` makes an incremental
 * protocol a sequence of conflicts for the client to reconcile. So `PUT` deactivates every
 * existing cap and writes the submitted set, atomically: either the campaign has the new budget
 * picture or it has the old one, never a half-applied mixture where the daily budget was raised
 * and the lifetime one was not.
 *
 * Existing rows are flipped to `status='inactive'` rather than deleted, because a cap is a
 * financial control and "what was the budget on the 3rd?" is a question somebody will ask.
 * `uq_cc_unique` does **not** include `status`, so a deactivated row still occupies its key —
 * which is why the write path reuses a matching inactive row (reactivating and updating it)
 * instead of inserting a second one. That subtlety is the reason this service does not simply
 * `destroy` and `create`.
 *
 * ### The legacy dual-write, and why the shared helper is not called
 *
 * `tenant_campaigns.budget_amount`/`budget_currency` are *"kept and maintained"* (§2) and
 * `src/common/caps/legacy-budget-sync.ts` exists to keep them in step — but that helper opens
 * **its own transaction** and writes through raw SQL, both of which are wrong here: this method
 * already holds a transaction that the legacy update must join, and R2 requires the cap write to
 * go through `ScopedRepository` so the tenant clause is not hand-maintained. What *is* reused is
 * the helper's `isLegacyBudgetShape` predicate — the actual decision about which cap has a legacy
 * equivalent — so the two paths can never disagree about that. Documented rather than silently
 * diverged (TC-21z).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { CampaignCap, TenantBudgetCeiling, TenantCampaign } from '@/database/models';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { assertRole } from '@/common/rbac/assert-role';
import { isLegacyBudgetShape } from '@/common/caps/legacy-budget-sync';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type { CampaignCapsResponse } from '@reward-portal/shared';
import { AUDIT_ACTION, AUDIT_ENTITY, ROW_ACTIVE, ROW_INACTIVE } from './campaigns.constants';
import { CapCurrencyMismatchError } from './campaigns.errors';
import { CampaignAuditService } from './campaign-audit.service';
import { BindingsService } from './bindings.service';
import { assertCapScopeRef } from './campaign-membership';
import { actorRefId } from './actor-ref';
import {
  analyseBudgetsWithCeilings,
  worstCasePayout,
  type CeilingRow,
  type RewardUnit,
} from './budget-analysis';
import { toCampaignCapDto } from './dto/campaign-response.dto';
import type { CampaignCapDto, PutCampaignCapsDto } from './dto/caps.dto';

@Injectable()
export class CapsService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly audit: CampaignAuditService,
    private readonly bindings: BindingsService,
  ) {}

  /** `GET /campaigns/:id/caps` — the caps plus everything step 6 renders alongside them. */
  async get(campaign: TenantCampaign): Promise<CampaignCapsResponse> {
    const [caps, ceilings, rewards] = await Promise.all([
      this.activeCaps(campaign.id),
      this.tenantCeilings(campaign.tenantId),
      this.bindings.rewardUnits(campaign.id),
    ]);
    return this.buildResponse(campaign, caps, ceilings, rewards);
  }

  /**
   * `PUT /campaigns/:id/caps` — TC-21r…TC-21cc.
   *
   * Never blocked by the tenant ceiling: *"draft saving is never blocked — a maker may draft
   * anything; the gate is submission"* (§8.4, TC-21gg). The ceiling appears in the **response**
   * as a warning and a `state`, and only `POST /submit` refuses.
   */
  async put(
    actor: AuthenticatedUser,
    campaign: TenantCampaign,
    dto: PutCampaignCapsDto,
  ): Promise<CampaignCapsResponse> {
    assertRole(actor, 'maker');

    await this.sequelize.transaction(async (transaction) => {
      this.assertCurrencyConfirmed(campaign, dto);

      for (const cap of dto.caps) {
        await assertCapScopeRef(
          this.scoped,
          campaign.id,
          cap.scopeLevel,
          cap.scopeRefId,
          transaction,
        );
      }

      const existing = await this.scoped.listAll(CampaignCap, {
        where: { campaignId: campaign.id },
        transaction,
      });

      // Deactivate everything first, then (re)activate what the maker sent. Doing it in this
      // order means a cap that was removed from the screen ends up inactive even if a cap with
      // the same unique key was added back — the second loop revives exactly the rows it matches.
      if (existing.length > 0) {
        await this.scoped.update(
          CampaignCap,
          { status: ROW_INACTIVE },
          { where: { campaignId: campaign.id }, transaction },
        );
      }

      for (const cap of dto.caps) {
        await this.upsertCap(campaign, cap, existing, actorRefId(actor), transaction);
      }

      await this.syncLegacyBudget(campaign, dto.caps, transaction);

      await this.audit.record(
        actor,
        {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          entityType: AUDIT_ENTITY.CAP_OVERRIDE,
          entityId: campaign.id,
          action: AUDIT_ACTION.UPDATED,
          fieldChanges: { capCount: dto.caps.length },
        },
        transaction,
      );
    });

    const reloaded = await this.scoped.findByPkOrFail(TenantCampaign, campaign.id);
    return this.get(reloaded);
  }

  /** Every active cap of `campaignId`, in a stable order. */
  async activeCaps(campaignId: number, transaction?: Transaction): Promise<CampaignCap[]> {
    return this.scoped.listAll(CampaignCap, {
      where: { campaignId, status: ROW_ACTIVE },
      order: [['id', 'ASC']],
      transaction,
    });
  }

  /**
   * The tenant's ceiling rows (§8.2). An empty list means **unlimited**, not blocked (§8.5) —
   * TC-21ii.
   */
  async tenantCeilings(tenantId: number, transaction?: Transaction): Promise<CeilingRow[]> {
    const rows = await this.scoped.listAll(TenantBudgetCeiling, {
      where: { tenantId, status: ROW_ACTIVE },
      transaction,
    });
    return rows.map((row) => ({
      unitType: row.unitType,
      unitCode: row.unitCode,
      maxCampaignBudget: row.maxCampaignBudget,
      warnAboveAmount: row.warnAboveAmount,
    }));
  }

  /** The whole step-6 payload, assembled from parts every caller already has. Shared with
   * `campaigns.service.ts#review` and `#submit` so the screen and the gate agree exactly. */
  buildResponse(
    campaign: TenantCampaign,
    caps: readonly CampaignCap[],
    ceilings: readonly CeilingRow[],
    rewards: readonly RewardUnit[],
  ): CampaignCapsResponse {
    const capDtos = caps.map(toCampaignCapDto);
    const { warnings, ceilings: statuses } = analyseBudgetsWithCeilings({
      caps: capDtos,
      ceilings,
      rewards,
      campaignCurrency: campaign.budgetCurrency === null ? null : campaign.budgetCurrency.trim(),
      startDate: campaign.startDate,
      endDate: campaign.endDate,
    });

    return {
      caps: capDtos,
      warnings: [...warnings],
      ceilings: [...statuses],
      worstCasePayout: [...worstCasePayout(rewards)],
    };
  }

  // --- private -------------------------------------------------------------------------------

  /**
   * TC-21bb — *"currency differing from the campaign currency requires explicit confirmation"*.
   *
   * Checked before anything is written, so a maker who meant MYR and typed SGD gets a clean 400
   * rather than a half-saved screen. Only `unitType='currency'` participates: a points or voucher
   * unit is not a currency and has nothing to differ from.
   */
  private assertCurrencyConfirmed(campaign: TenantCampaign, dto: PutCampaignCapsDto): void {
    if (dto.confirmCurrencyMismatch === true) return;
    const campaignCurrency = campaign.budgetCurrency?.trim() ?? null;
    if (campaignCurrency === null) return;

    const mismatched = [
      ...new Set(
        dto.caps
          .filter(
            (cap) =>
              cap.unitType === 'currency' &&
              typeof cap.unitCode === 'string' &&
              cap.unitCode !== campaignCurrency,
          )
          .map((cap) => cap.unitCode as string),
      ),
    ];
    if (mismatched.length > 0) throw new CapCurrencyMismatchError(mismatched);
  }

  /**
   * Writes one cap, reusing the row that already holds its unique key when there is one.
   *
   * `uq_cc_unique` spans `(campaign_id, cap_class, scope_level, period_type, dedupe_key)` and
   * `dedupe_key` is a **generated** column (T006_001, AR-02) — so it can be neither written nor
   * matched on directly from here. The equivalent match is reconstructed from the six columns
   * that feed it, which is exactly what {@link sameKey} does.
   */
  private async upsertCap(
    campaign: TenantCampaign,
    cap: CampaignCapDto,
    existing: readonly CampaignCap[],
    createdBy: number,
    transaction: Transaction,
  ): Promise<void> {
    const values = {
      tenantId: campaign.tenantId,
      campaignId: campaign.id,
      capClass: cap.capClass,
      scopeLevel: cap.scopeLevel,
      scopeRefId: cap.scopeRefId ?? null,
      periodType: cap.periodType,
      periodValue: cap.periodValue ?? null,
      windowStartTime: cap.windowStartTime ?? null,
      windowEndTime: cap.windowEndTime ?? null,
      // Omitted deliberately when absent: `trg_cc_default_timezone` fills it from the campaign's
      // country (§4.2), which is the behaviour a Malaysian campaign needs and which application
      // code guessing "UTC" would silently break.
      periodTimezone: cap.periodTimezone ?? null,
      unitType: cap.unitType ?? null,
      unitCode: cap.unitCode ?? null,
      rewardType: cap.rewardType ?? null,
      maxTotalAmount: cap.maxTotalAmount ?? null,
      maxOccurrences: cap.maxOccurrences ?? null,
      maxCustomers: cap.maxCustomers ?? null,
      onBreach: cap.onBreach ?? 'reject',
      warnAtPercent: cap.warnAtPercent ?? null,
      status: ROW_ACTIVE,
    };

    const match = existing.find((row) => sameKey(row, cap));
    if (match !== undefined) {
      await this.scoped.update(CampaignCap, values, { where: { id: match.id }, transaction });
      return;
    }

    await this.scoped.create(CampaignCap, { ...values, createdBy } as never, { transaction });
  }

  /**
   * TC-21z — *"campaign lifetime budget set → `tenant_campaigns.budget_amount` also updated"*.
   *
   * `isLegacyBudgetShape` is imported from `common/caps/legacy-budget-sync.ts` rather than
   * re-expressed: it is the one place that decides which cap shape has a legacy equivalent
   * (budget · campaign · lifetime · **currency** — a points budget has no legacy column that
   * could represent it without mislabelling `budget_currency`). See this file's header for why
   * the helper's own write function is not used.
   *
   * When no such cap exists the legacy pair is left **untouched** rather than nulled: a maker who
   * set a budget in step 1 and has not yet added a `campaign_caps` row in step 6 has not
   * withdrawn it, and clearing it here would silently undo their own step-1 entry.
   */
  private async syncLegacyBudget(
    campaign: TenantCampaign,
    caps: readonly CampaignCapDto[],
    transaction: Transaction,
  ): Promise<void> {
    const legacy = caps.find((cap) =>
      isLegacyBudgetShape({
        capClass: cap.capClass,
        scopeLevel: cap.scopeLevel,
        periodType: cap.periodType,
        unitType: cap.unitType ?? null,
      }),
    );
    if (
      legacy === undefined ||
      legacy.maxTotalAmount === undefined ||
      legacy.maxTotalAmount === null
    ) {
      return;
    }

    await this.scoped.update(
      TenantCampaign,
      {
        // `decimal(18,2)` on the legacy column against `decimal(18,4)` on the cap. Postgres
        // rounds the cast itself; passing the string through unchanged keeps this code free of a
        // rounding decision it has no business making.
        budgetAmount: legacy.maxTotalAmount,
        budgetCurrency: legacy.unitCode ?? null,
      },
      { where: { id: campaign.id }, transaction },
    );
  }
}

/** Whether `row` already occupies the `uq_cc_unique` key `cap` would claim — see
 * {@link CapsService.upsertCap}. */
function sameKey(row: CampaignCap, cap: CampaignCapDto): boolean {
  return (
    row.capClass === cap.capClass &&
    row.scopeLevel === cap.scopeLevel &&
    row.periodType === cap.periodType &&
    nullableEqual(row.scopeRefId, cap.scopeRefId) &&
    nullableEqual(row.periodValue, cap.periodValue) &&
    timeEqual(row.windowStartTime, cap.windowStartTime) &&
    nullableEqual(row.unitType, cap.unitType) &&
    nullableEqual(row.unitCode, cap.unitCode) &&
    nullableEqual(row.rewardType, cap.rewardType)
  );
}

function nullableEqual(left: unknown, right: unknown): boolean {
  return (left ?? null) === (right ?? null);
}

/** `time` columns come back from Postgres as `HH:MM:SS` while the wire accepts `HH:MM`. Compared
 * on the first five characters so `18:00` and `18:00:00` are the same key, which is what
 * `dedupe_key` — built from the column's own text form — effectively does. */
function timeEqual(left: string | null, right: string | null | undefined): boolean {
  const normalise = (value: string | null | undefined): string | null =>
    value === null || value === undefined ? null : value.slice(0, 5);
  return normalise(left) === normalise(right);
}
