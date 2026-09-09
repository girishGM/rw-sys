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
import type { BindLevel } from './generation-request.types';
import type { CharacterSet, RewardValueType } from '../promo-code-config/promo-code-config.entity';

/** Postgres error code for a unique-violation (23505) — checked, not string-matched. */
export const PG_UNIQUE_VIOLATION = '23505';
export const UC_PROMO_CODE_CODE = 'uc_promo_code_code';
export const UC_PROMO_CODE_CORRELATION = 'uc_promo_code_correlation';

export interface CreatePromoCodeData {
  promoCodeConfigId: string;
  /**
   * T-PC-060 (defect fix filed against T-PC-058). The `promo_code_config_version` actually
   * resolved (pinned or explicit) for this generation — always populated for every new row
   * (migration `T-PC-058_004_promo_code_version_column.ts`'s own note: "nullable at the DB level
   * for pre-existing rows, always populated for every new one"). `PromoCodeGenerationService` is
   * responsible for having already resolved this before calling `create`.
   */
  promoCodeConfigVersionId: string;
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
  // T-PC-056: widened to add 'REST' — append-only (R8), matching `promo-code.entity.ts`'s own
  // widen for the same task.
  transport: 'KAFKA' | 'GRPC' | 'REST';
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

/**
 * T-PC-060 (defect fix filed against T-PC-058). Raw `promo_code.promo_code_config_version` row
 * shape (migration `T-PC-058_001_split_promo_code_config_version.ts`) — the code-generation and
 * payout columns that used to live directly on `promo_code_config` before that split. Declared
 * here, not in `promo-code-config.entity.ts`, because that file (and the rest of
 * `src/modules/promo-code-config/**`) is `agent-promo-config`'s exclusive scope (R8); this
 * service's own generation logic needs to read this table regardless of whether that module's own
 * version-aware model has landed yet (T-PC-058, still blocked on this task).
 */
export interface PromoCodeConfigVersionRow {
  id: string;
  promo_code_config_id: string;
  version_no: number;
  code_prefix: string | null;
  code_postfix: string | null;
  code_length: number;
  character_set: CharacterSet;
  exclude_ambiguous_chars: boolean;
  reward_value_type: RewardValueType;
  reward_value: string;
  reward_unit: string;
  code_expiry_days: number | null;
  status: 'draft' | 'published' | 'deprecated' | 'retired';
}

/** Domain shape — camelCase, the only shape `PromoCodeGenerationService` itself works with. */
export interface PromoCodeConfigVersion {
  id: string;
  promoCodeConfigId: string;
  versionNo: number;
  codePrefix: string | null;
  codePostfix: string | null;
  codeLength: number;
  characterSet: CharacterSet;
  excludeAmbiguousChars: boolean;
  rewardValueType: RewardValueType;
  rewardValue: string;
  rewardUnit: string;
  codeExpiryDays: number | null;
  status: 'draft' | 'published' | 'deprecated' | 'retired';
}

function toVersionDomain(row: PromoCodeConfigVersionRow): PromoCodeConfigVersion {
  return {
    id: row.id,
    promoCodeConfigId: row.promo_code_config_id,
    versionNo: row.version_no,
    codePrefix: row.code_prefix,
    codePostfix: row.code_postfix,
    codeLength: row.code_length,
    characterSet: row.character_set,
    excludeAmbiguousChars: row.exclude_ambiguous_chars,
    rewardValueType: row.reward_value_type,
    rewardValue: row.reward_value,
    rewardUnit: row.reward_unit,
    codeExpiryDays: row.code_expiry_days,
    status: row.status,
  };
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
         (promo_code_config_id, promo_code_config_version_id, campaign_promo_config_id, code,
          customer_id, tenant_id, merchant_id, reward_value_type, reward_value, reward_unit,
          correlation_id, transport, expires_at)
       VALUES
         (:promoCodeConfigId, :promoCodeConfigVersionId, :campaignPromoConfigId, :code,
          :customerId, :tenantId, :merchantId, :rewardValueType, :rewardValue, :rewardUnit,
          :correlationId, :transport,
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

  /**
   * T-PC-060 (defect fix filed against T-PC-058). The `promo_code_config_version_id` a
   * `campaign_promo_config` binding is currently pinned to — `campaign_promo_config`'s own bind-
   * write path (`src/modules/campaign-binding/**`) is `agent-promo-config`'s exclusive scope
   * (R8), so this read lives here instead, scoped the same way
   * `CampaignBindingRepository.findActiveBinding` already scopes its own read of the same table
   * (`tenant_id`/`bind_level`/`bind_ref_id`/`status = 'ACTIVE'`) — deliberately duplicated rather
   * than widening `CampaignBindingService.resolveActiveBinding`'s own return shape, exactly the
   * precedent `CreatePromoCodeData.campaignPromoConfigId`'s own comment above already established
   * for this same cross-module boundary.
   */
  async findActiveBindingVersionId(
    tenantId: string,
    bindLevel: BindLevel,
    bindRefId: string,
  ): Promise<string | null> {
    const rows = await this.sequelize.query<{ promo_code_config_version_id: string | null }>(
      `SELECT promo_code_config_version_id FROM promo_code.campaign_promo_config
         WHERE tenant_id = :tenantId AND bind_level = :bindLevel AND bind_ref_id = :bindRefId
           AND status = 'ACTIVE'`,
      { type: QueryTypes.SELECT, replacements: { tenantId, bindLevel, bindRefId } },
    );
    return rows[0]?.promo_code_config_version_id ?? null;
  }

  /**
   * T-PC-060. Resolves a `promo_code_config_version` by its own `id`, scoped by `tenantId` via a
   * join back to the identity table (R2 — every read scoped, never a bare `id` lookup) — used to
   * hydrate the binding's currently-pinned version (`findActiveBindingVersionId` above) into the
   * full payout-bearing row `generateWithRetry` needs, and to resolve the `version_no` an
   * already-issued `promo_code.promo_code_config_version_id` FK points at (idempotent replay /
   * correlation-conflict read-back — neither has the resolved version at hand directly).
   */
  async findVersionById(
    tenantId: string,
    versionId: string,
  ): Promise<PromoCodeConfigVersion | null> {
    const rows = await this.sequelize.query<PromoCodeConfigVersionRow>(
      `SELECT v.* FROM promo_code.promo_code_config_version v
         JOIN promo_code.promo_code_config c ON c.id = v.promo_code_config_id
        WHERE v.id = :versionId AND c.tenant_id = :tenantId`,
      { type: QueryTypes.SELECT, replacements: { tenantId, versionId } },
    );
    return rows[0] ? toVersionDomain(rows[0]) : null;
  }

  /**
   * T-PC-060. Resolves an explicit, caller-supplied `versionNo` against a specific
   * `promoCodeConfigId` (`tenantId`-scoped) — the "validate it belongs to the resolved config"
   * half of implementation note 4. Returns `null` both when `versionNo` doesn't exist at all *and*
   * when it exists but belongs to a different config — `PromoCodeGenerationService` doesn't need
   * to distinguish the two (TC-8: either way, `VERSION_NOT_FOUND`, never a silent substitution).
   */
  async findVersionByConfigAndVersionNo(
    tenantId: string,
    promoCodeConfigId: string,
    versionNo: number,
  ): Promise<PromoCodeConfigVersion | null> {
    const rows = await this.sequelize.query<PromoCodeConfigVersionRow>(
      `SELECT v.* FROM promo_code.promo_code_config_version v
         JOIN promo_code.promo_code_config c ON c.id = v.promo_code_config_id
        WHERE v.promo_code_config_id = :promoCodeConfigId AND v.version_no = :versionNo
          AND c.tenant_id = :tenantId`,
      { type: QueryTypes.SELECT, replacements: { tenantId, promoCodeConfigId, versionNo } },
    );
    return rows[0] ? toVersionDomain(rows[0]) : null;
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
