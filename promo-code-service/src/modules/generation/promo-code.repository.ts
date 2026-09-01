/**
 * T-PC-021. Scoped repository for `promo_code.promo_code` (+ the write side of
 * `promo_code.promo_code_outbox` — implementation note 4: both rows are written in the same DB
 * transaction, so that write lives here rather than in a separate module, precisely so a caller
 * can never insert one without the other). Every read method takes `tenantId` as a mandatory
 * first-class parameter and bakes it into the `WHERE` clause itself (AGENT-PROTOCOL.md R2), same
 * discipline `promo-code-config.repository.ts`/`campaign-binding.repository.ts` already
 * established.
 *
 * Talks to Postgres with parameterised `sequelize.query(...)`, this project's established
 * convention (raw-SQL migrations, no `@Table` models) — see `promo-code-config.repository.ts`'s
 * own header.
 *
 * Deliberately dumb about both unique-constraint races on `create`, same discipline
 * `campaign-binding.repository.ts` already established for its own table: a `23505` on either
 * `uc_promo_code_code` (a genuine random-code collision) or `uc_promo_code_correlation` (a
 * concurrent-same-`correlationId` race, TC-13) bubbles up as the raw Sequelize error. Translating
 * it here would throw away the constraint name `PromoCodeGenerationService` needs to tell those
 * two outcomes apart (implementation note 3: one is "regenerate and retry", the other is "read
 * back the row the other caller just committed").
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import type { Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';
import { PROMO_CODE_SEQUELIZE } from '../promo-code-config/promo-code-config.constants';
import type { PromoCode, PromoCodeRow } from './promo-code.entity';
import { toDomain } from './promo-code.entity';

/** Postgres error code for a unique-violation (23505) — checked, not string-matched. */
export const PG_UNIQUE_VIOLATION = '23505';
export const UC_PROMO_CODE_CODE = 'uc_promo_code_code';
export const UC_PROMO_CODE_CORRELATION = 'uc_promo_code_correlation';

export interface CreatePromoCodeData {
  promoCodeConfigId: string;
  /**
   * `campaign_promo_config_id` FK — left `null` on every insert. `CampaignBindingService.
   * resolveActiveBinding` (T-PC-012) returns only the resolved `promoCodeConfigId`, never the
   * binding row's own `id`; widening that return shape is outside this task's file scope (R8).
   * No test case in this task requires this column populated — flagged in the completion report
   * for the architect rather than silently redesigned (AGENT-PROTOCOL.md §7).
   */
  campaignPromoConfigId: string | null;
  code: string;
  customerId: string;
  tenantId: string;
  merchantId: string | null;
  rewardValueType: string;
  rewardValue: string;
  rewardUnit: string;
  correlationId: string;
  transport: 'KAFKA' | 'GRPC';
  /**
   * `null` when the resolved config's `codeExpiryDays` is `null` (never expires, TC-17).
   * Computed in SQL as `now() + (:codeExpiryDays || ' days')::interval` rather than in
   * application code (TC-16): `now()` is stable for the whole statement/transaction, so this is
   * computed off the *exact same* timestamp `issued_at`'s own `DEFAULT now()` uses in the same
   * `INSERT`, guaranteeing `expires_at - issued_at` is exactly `codeExpiryDays` days with no
   * clock-skew risk a JS-side `new Date()` computed moments earlier/later could introduce.
   */
  codeExpiryDays: number | null;
}

export interface CreateOutboxRowData {
  promoCodeId: string;
  topic: string;
  payload: Record<string, unknown>;
}

export interface RepositoryOptions {
  transaction?: Transaction;
}

@Injectable()
export class PromoCodeRepository {
  constructor(@Inject(PROMO_CODE_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * Implementation note 2: the idempotency read. Called first, before any binding resolution or
   * generation work — a found row means "do not generate again", per `02-KAFKA-CONTRACTS.md` §4.
   */
  async findByCorrelationId(
    tenantId: string,
    correlationId: string,
    options: RepositoryOptions = {},
  ): Promise<PromoCode | null> {
    const rows = await this.sequelize.query<PromoCodeRow>(
      `SELECT * FROM promo_code.promo_code
         WHERE tenant_id = :tenantId AND correlation_id = :correlationId`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, correlationId },
        transaction: options.transaction,
      },
    );
    return rows[0] ? toDomain(rows[0]) : null;
  }

  /**
   * Never call outside a transaction that (for a `KAFKA`-transport request) also calls
   * `createOutboxRow` — implementation note 4: success means both rows exist, failure means
   * neither does.
   */
  async create(data: CreatePromoCodeData, options: RepositoryOptions = {}): Promise<PromoCode> {
    const [row] = await this.sequelize.query<PromoCodeRow>(
      `INSERT INTO promo_code.promo_code
         (promo_code_config_id, campaign_promo_config_id, code, customer_id, tenant_id,
          merchant_id, reward_value_type, reward_value, reward_unit, correlation_id, transport,
          expires_at)
       VALUES
         (:promoCodeConfigId, :campaignPromoConfigId, :code, :customerId, :tenantId,
          :merchantId, :rewardValueType, :rewardValue, :rewardUnit, :correlationId, :transport,
          CASE WHEN :codeExpiryDays::int IS NULL THEN NULL
               ELSE now() + (:codeExpiryDays::text || ' days')::interval END)
       RETURNING *`,
      {
        type: QueryTypes.SELECT,
        replacements: { ...data },
        transaction: options.transaction,
      },
    );
    return toDomain(row);
  }

  /**
   * Implementation note 5 (`01-DATABASE.md` §4's closing note): only ever called for a
   * `KAFKA`-transport request, in the same transaction as `create`. `PromoCodeGenerationService`
   * decides whether to call this at all — this repository has no opinion on transport.
   */
  async createOutboxRow(data: CreateOutboxRowData, options: RepositoryOptions = {}): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO promo_code.promo_code_outbox (promo_code_id, topic, payload)
       VALUES (:promoCodeId, :topic, :payload)`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          promoCodeId: data.promoCodeId,
          topic: data.topic,
          payload: JSON.stringify(data.payload),
        },
        transaction: options.transaction,
      },
    );
  }

  /** `true` when `error` is a `23505` on `uc_promo_code_code` — a genuine random-code collision. */
  isCodeCollision(error: unknown): boolean {
    return this.isUniqueViolation(error, UC_PROMO_CODE_CODE);
  }

  /**
   * `true` when `error` is a `23505` on `uc_promo_code_correlation` — a concurrent request for the
   * same `correlationId` committed first (TC-13), not a collision to retry past.
   */
  isCorrelationConflict(error: unknown): boolean {
    return this.isUniqueViolation(error, UC_PROMO_CODE_CORRELATION);
  }

  private isUniqueViolation(error: unknown, constraint: string): boolean {
    const parent = (error as { parent?: { code?: string; constraint?: string } } | undefined)
      ?.parent;
    return parent?.code === PG_UNIQUE_VIOLATION && parent?.constraint === constraint;
  }
}
