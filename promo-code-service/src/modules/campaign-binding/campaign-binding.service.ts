/**
 * T-PC-012. Bind/rebind logic for `campaign_promo_config` — the single place the REST layer
 * (this task's own controller) and T-PC-021's generation service both go through, never bypassed
 * (Objective).
 *
 * DTO parsing happens **here**, not in the controller — same "service owns structural validity
 * end to end" discipline `PromoCodeConfigService` (T-PC-010) established: `bind` accepts an
 * `unknown` request body and parses it itself, so the controller stays a thin adapter.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { PROMO_CODE_SEQUELIZE } from '../promo-code-config/promo-code-config.constants';
import { PromoCodeConfigService } from '../promo-code-config/promo-code-config.service';
import { CampaignBindingRepository } from './campaign-binding.repository';
import type { BindLevel, CampaignPromoConfig } from './campaign-promo-config.entity';
import { BindingConflictError, ConfigNotActiveError } from './campaign-binding.errors';
import {
  parseCreateCampaignPromoConfigDto,
  type CreateCampaignPromoConfigDto,
} from './dto/create-campaign-promo-config.dto';

/** Postgres error code for a unique-violation (23505) — checked, not string-matched. */
const PG_UNIQUE_VIOLATION = '23505';
const ACTIVE_BINDING_CONSTRAINT = 'uc_campaign_promo_config_active';

/**
 * Implementation note 5: `resolveActiveBinding` returns a typed, three-way outcome rather than a
 * bare nullable id, so T-PC-021 can map "no binding at all" (`CONFIG_NOT_BOUND`,
 * `02-KAFKA-CONTRACTS.md` §5) and "bound, but the underlying config is no longer ACTIVE"
 * (`CONFIG_INACTIVE`) to two distinct outcomes without re-deriving the distinction itself.
 */
export type ResolveBindingResult =
  | { outcome: 'NOT_BOUND' }
  | { outcome: 'CONFIG_INACTIVE'; promoCodeConfigId: string }
  | { outcome: 'RESOLVED'; promoCodeConfigId: string };

@Injectable()
export class CampaignBindingService {
  constructor(
    private readonly repository: CampaignBindingRepository,
    private readonly promoCodeConfigService: PromoCodeConfigService,
    @Inject(PROMO_CODE_SEQUELIZE) private readonly sequelize: Sequelize,
  ) {}

  /**
   * `04-API-CONTRACT.md` §2. Validates the target config is `ACTIVE` for the given tenant
   * *before* touching `campaign_promo_config` at all (implementation note 2), then deactivates
   * any existing active binding for the same `(tenantId, bindLevel, bindRefId)` and inserts the
   * new one inside a single transaction (implementation note 1) — never two separate statements
   * a crash could split.
   */
  async bind(input: unknown): Promise<CampaignPromoConfig> {
    const dto = parseCreateCampaignPromoConfigDto(input);
    await this.assertConfigActive(dto.tenantId, dto.promoCodeConfigId);
    return this.deactivateAndCreateWithRetry(dto, 1);
  }

  /**
   * `(tenantId, bindLevel, bindRefId) → promo_code_config_id`, built here because
   * `campaign_promo_config` is this module's own table (implementation note 5), consumed by
   * T-PC-021 as a plain in-process method call.
   */
  async resolveActiveBinding(
    tenantId: string,
    bindLevel: BindLevel,
    bindRefId: string,
  ): Promise<ResolveBindingResult> {
    const binding = await this.repository.findActiveBinding(tenantId, bindLevel, bindRefId);
    if (!binding) {
      return { outcome: 'NOT_BOUND' };
    }
    const config = await this.promoCodeConfigService.findById(tenantId, binding.promoCodeConfigId);
    if (!config || config.status !== 'ACTIVE') {
      return { outcome: 'CONFIG_INACTIVE', promoCodeConfigId: binding.promoCodeConfigId };
    }
    return { outcome: 'RESOLVED', promoCodeConfigId: binding.promoCodeConfigId };
  }

  private async assertConfigActive(tenantId: string, promoCodeConfigId: string): Promise<void> {
    const config = await this.promoCodeConfigService.findById(tenantId, promoCodeConfigId);
    if (!config || config.status !== 'ACTIVE') {
      throw new ConfigNotActiveError(tenantId, promoCodeConfigId);
    }
  }

  /**
   * Implementation note 3: the unique partial index, not this "check then deactivate" sequence,
   * is the real concurrency safety net. Two simultaneous binds for the same `(tenantId,
   * bindLevel, bindRefId)` can both enter this method before either commits; whichever commits
   * second gets a `23505` on its own `INSERT`, which is treated as an expected, retryable race
   * (TC-10) — retried once, re-reading whatever is now active and deactivating it, rather than
   * assumed to be a permanent failure. Only a second collision in a row surfaces as a `409`.
   */
  private async deactivateAndCreateWithRetry(
    dto: CreateCampaignPromoConfigDto,
    retriesLeft: number,
  ): Promise<CampaignPromoConfig> {
    try {
      return await this.sequelize.transaction(async (transaction) => {
        await this.repository.deactivateActive(dto.tenantId, dto.bindLevel, dto.bindRefId, {
          transaction,
        });
        return this.repository.create(
          dto.tenantId,
          {
            promoCodeConfigId: dto.promoCodeConfigId,
            bindLevel: dto.bindLevel,
            bindRefId: dto.bindRefId,
            boundBy: dto.boundBy,
          },
          { transaction },
        );
      });
    } catch (error) {
      if (this.isActiveBindingConflict(error)) {
        if (retriesLeft > 0) {
          return this.deactivateAndCreateWithRetry(dto, retriesLeft - 1);
        }
        throw new BindingConflictError(dto.tenantId, dto.bindLevel, dto.bindRefId);
      }
      throw error;
    }
  }

  private isActiveBindingConflict(error: unknown): boolean {
    const parent = (error as { parent?: { code?: string; constraint?: string } } | undefined)
      ?.parent;
    return parent?.code === PG_UNIQUE_VIOLATION && parent?.constraint === ACTIVE_BINDING_CONSTRAINT;
  }
}
