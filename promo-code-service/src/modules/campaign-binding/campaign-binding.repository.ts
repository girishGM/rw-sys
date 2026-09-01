/**
 * T-PC-012. Scoped repository for `promo_code.campaign_promo_config` — every method takes
 * `tenantId` as a mandatory first-class parameter and bakes it into the `WHERE`/`INSERT` clause
 * itself (AGENT-PROTOCOL.md R2), same discipline `promo-code-config.repository.ts` (T-PC-010)
 * already established for the sibling table.
 *
 * Deliberately dumb about the unique-partial-index race (implementation note 3): `create` lets a
 * `23505` unique-violation on `uc_campaign_promo_config_active` bubble up as the raw Sequelize
 * error, unlike `PromoCodeConfigRepository.create`'s own `translateUniqueViolation`. That
 * violation is not a terminal error here — `CampaignBindingService` treats it as an expected,
 * retryable race outcome (retry the whole deactivate+insert sequence once) and only translates
 * it to a typed `BindingConflictError` if the retry also loses the race. Translating too early,
 * in this repository, would throw away the information the service needs to decide "retry" vs.
 * "give up".
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import type { Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';
import { PROMO_CODE_SEQUELIZE } from '../promo-code-config/promo-code-config.constants';
import type {
  BindLevel,
  CampaignPromoConfig,
  CampaignPromoConfigRow,
} from './campaign-promo-config.entity';
import { toDomain } from './campaign-promo-config.entity';

export interface CreateCampaignPromoConfigData {
  promoCodeConfigId: string;
  bindLevel: BindLevel;
  bindRefId: string;
  boundBy: string;
}

export interface RepositoryOptions {
  transaction?: Transaction;
}

@Injectable()
export class CampaignBindingRepository {
  constructor(@Inject(PROMO_CODE_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * Never call outside a transaction that also calls `deactivateActive` first — the unique
   * partial index (`uc_campaign_promo_config_active`) is what actually prevents two active rows
   * for the same `(tenant_id, bind_level, bind_ref_id)`, but the "preserve history, never
   * overwrite" guarantee (`01-DATABASE.md` §2) depends on both statements committing together
   * or not at all.
   */
  async create(
    tenantId: string,
    data: CreateCampaignPromoConfigData,
    options: RepositoryOptions = {},
  ): Promise<CampaignPromoConfig> {
    const [row] = await this.sequelize.query<CampaignPromoConfigRow>(
      `INSERT INTO promo_code.campaign_promo_config
         (promo_code_config_id, tenant_id, bind_level, bind_ref_id, bound_by)
       VALUES
         (:promoCodeConfigId, :tenantId, :bindLevel, :bindRefId, :boundBy)
       RETURNING *`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, ...data },
        transaction: options.transaction,
      },
    );
    return toDomain(row);
  }

  /**
   * Deactivates whatever is currently `ACTIVE` for this `(tenant, level, ref)` — zero, one, or
   * (in a benign race) briefly more than one row matched here is all fine; this statement makes
   * none of them active, it never itself creates the new row.
   */
  async deactivateActive(
    tenantId: string,
    bindLevel: BindLevel,
    bindRefId: string,
    options: RepositoryOptions = {},
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE promo_code.campaign_promo_config
         SET status = 'INACTIVE', updated_at = now()
         WHERE tenant_id = :tenantId AND bind_level = :bindLevel AND bind_ref_id = :bindRefId
           AND status = 'ACTIVE'`,
      {
        type: QueryTypes.UPDATE,
        replacements: { tenantId, bindLevel, bindRefId },
        transaction: options.transaction,
      },
    );
  }

  /** The resolve-by-binding read T-PC-021 consumes via `CampaignBindingService.resolveActiveBinding`. */
  async findActiveBinding(
    tenantId: string,
    bindLevel: BindLevel,
    bindRefId: string,
    options: RepositoryOptions = {},
  ): Promise<CampaignPromoConfig | null> {
    const rows = await this.sequelize.query<CampaignPromoConfigRow>(
      `SELECT * FROM promo_code.campaign_promo_config
         WHERE tenant_id = :tenantId AND bind_level = :bindLevel AND bind_ref_id = :bindRefId
           AND status = 'ACTIVE'`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, bindLevel, bindRefId },
        transaction: options.transaction,
      },
    );
    return rows[0] ? toDomain(rows[0]) : null;
  }
}
