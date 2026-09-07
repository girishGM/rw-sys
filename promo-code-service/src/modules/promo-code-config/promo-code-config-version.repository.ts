/**
 * T-PC-058. Scoped repository for `promo_code.promo_code_config_version` — every method takes
 * `tenantId` as a mandatory first-class parameter, enforced via a join back to the owning
 * `promo_code_config` identity row (AGENT-PROTOCOL.md R2), same discipline
 * `promo-code-config.repository.ts` (T-PC-010) already established for the sibling table.
 *
 * Talks to Postgres with parameterised `sequelize.query(...)` — this project's migrations are raw
 * SQL, not `sequelize-typescript` `@Table` models (see `promo-code-config.repository.ts`'s own
 * header), so this repository stays consistent with that convention.
 *
 * Every write here operates only on `draft` rows (`createDraft`/`updateDraft`) or a `draft ->
 * published` transition (`publish`) — never a direct edit of a `published`/`deprecated`/`retired`
 * row's payload, which migration `T-PC-058_002`'s own DB trigger
 * (`fn_promo_code_config_version_immutable`) would reject outright regardless of what this
 * repository attempts. This repository's own SQL additionally scopes every write to `status =
 * 'draft'` so a caller never even reaches that trigger for the ordinary case — the trigger is the
 * last line of defence (a direct `psql` `UPDATE` bypassing this service entirely, TC-5), not the
 * first.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import type { Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';
import { PROMO_CODE_SEQUELIZE } from './promo-code-config.constants';
import { DraftAlreadyExistsError } from './promo-code-config.errors';
import type { CharacterSet, RewardValueType } from './promo-code-config.entity';
import type {
  PromoCodeConfigVersion,
  PromoCodeConfigVersionRow,
} from './promo-code-config-version.entity';
import { toDomain } from './promo-code-config-version.entity';

export interface CreatePromoCodeConfigVersionData {
  codePrefix: string | null;
  codePostfix: string | null;
  codeLength: number;
  characterSet: CharacterSet;
  excludeAmbiguousChars: boolean;
  rewardValueType: RewardValueType;
  rewardValue: number;
  rewardUnit: string;
  maxRedemptionsPerCode: number;
  codeExpiryDays: number | null;
  createdBy: string;
}

/** Every key is optional — only the keys present are written to the row. */
export type UpdatePromoCodeConfigVersionData = Partial<
  Omit<CreatePromoCodeConfigVersionData, 'createdBy'>
>;

export interface RepositoryOptions {
  transaction?: Transaction;
}

export type PublishOutcome =
  | { outcome: 'PUBLISHED'; version: PromoCodeConfigVersion }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'NOT_DRAFT' };

const COLUMN_BY_FIELD: Record<keyof UpdatePromoCodeConfigVersionData, string> = {
  codePrefix: 'code_prefix',
  codePostfix: 'code_postfix',
  codeLength: 'code_length',
  characterSet: 'character_set',
  excludeAmbiguousChars: 'exclude_ambiguous_chars',
  rewardValueType: 'reward_value_type',
  rewardValue: 'reward_value',
  rewardUnit: 'reward_unit',
  maxRedemptionsPerCode: 'max_redemptions_per_code',
  codeExpiryDays: 'code_expiry_days',
};

/** Postgres error code for a unique-violation (23505) — checked, not string-matched. */
const PG_UNIQUE_VIOLATION = '23505';
const DRAFT_CONFLICT_CONSTRAINTS = new Set(['uq_pccv_one_draft', 'uq_pccv_config_version']);

@Injectable()
export class PromoCodeConfigVersionRepository {
  constructor(@Inject(PROMO_CODE_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * Creates the next `draft` version for `promoCodeConfigId` — `version_no` is computed as
   * `MAX(existing version_no) + 1` for that config (starting at 1), and `supersedes_version_id` is
   * set to whatever is currently `published` for the config (if any), all inside one `INSERT ...
   * SELECT` so the whole thing is atomic against a concurrent second draft attempt: `uq_pccv_one_
   * draft` (a partial unique index on `status = 'draft'`) is the actual concurrency safety net —
   * two concurrent callers can both pass any application-level "is there a draft already?" check,
   * but only one of their inserts can ever commit; the loser's `23505` is translated to a typed
   * `DraftAlreadyExistsError` here, never left as a raw driver error.
   *
   * Returns `null` if `promoCodeConfigId` doesn't resolve to a row owned by `tenantId` — the `INSERT
   * ... SELECT ... FROM promo_code_config WHERE id = ... AND tenant_id = ...` source simply yields
   * zero rows, so nothing is inserted and `RETURNING *` comes back empty. Every caller in this
   * module (`PromoCodeConfigService`) has already resolved and tenant-checked the identity row
   * immediately before calling this, so this is a defensive/never-expected branch, not a normal
   * outcome (R3).
   */
  async createDraft(
    tenantId: string,
    promoCodeConfigId: string,
    data: CreatePromoCodeConfigVersionData,
    options: RepositoryOptions = {},
  ): Promise<PromoCodeConfigVersion | null> {
    try {
      const rows = await this.sequelize.query<PromoCodeConfigVersionRow>(
        `INSERT INTO promo_code.promo_code_config_version
           (promo_code_config_id, version_no, code_prefix, code_postfix, code_length,
            character_set, exclude_ambiguous_chars, reward_value_type, reward_value, reward_unit,
            max_redemptions_per_code, code_expiry_days, status, supersedes_version_id, created_by)
         SELECT c.id,
                COALESCE(
                  (SELECT MAX(version_no) FROM promo_code.promo_code_config_version
                    WHERE promo_code_config_id = c.id), 0
                ) + 1,
                :codePrefix, :codePostfix, :codeLength, :characterSet, :excludeAmbiguousChars,
                :rewardValueType, :rewardValue, :rewardUnit, :maxRedemptionsPerCode,
                :codeExpiryDays, 'draft',
                (SELECT id FROM promo_code.promo_code_config_version
                  WHERE promo_code_config_id = c.id AND status = 'published'),
                :createdBy
           FROM promo_code.promo_code_config c
          WHERE c.id = :promoCodeConfigId AND c.tenant_id = :tenantId
          RETURNING *`,
        {
          type: QueryTypes.SELECT,
          replacements: { tenantId, promoCodeConfigId, ...data },
          transaction: options.transaction,
        },
      );
      return rows[0] ? toDomain(rows[0]) : null;
    } catch (error) {
      throw this.translateDraftConflict(error, tenantId, promoCodeConfigId);
    }
  }

  /**
   * Edits the config's own currently-open `draft` version — a no-op passthrough (returns the
   * current draft unchanged) when `data` is empty, same convention as
   * `PromoCodeConfigRepository.update`. Scoped by `status = 'draft'` in the `WHERE` clause itself,
   * so this can never touch a `published`/`deprecated`/`retired` row even if a caller somehow
   * bypassed the service-layer "must have an open draft" check.
   */
  async updateDraft(
    tenantId: string,
    promoCodeConfigId: string,
    data: UpdatePromoCodeConfigVersionData,
    options: RepositoryOptions = {},
  ): Promise<PromoCodeConfigVersion | null> {
    const fields = Object.keys(data) as Array<keyof UpdatePromoCodeConfigVersionData>;
    if (fields.length === 0) {
      return this.findDraftForConfig(tenantId, promoCodeConfigId, options);
    }
    const setClause = fields.map((field) => `${COLUMN_BY_FIELD[field]} = :${field}`).join(', ');
    const rows = await this.sequelize.query<PromoCodeConfigVersionRow>(
      `UPDATE promo_code.promo_code_config_version v
          SET ${setClause}, updated_at = now()
         FROM promo_code.promo_code_config c
        WHERE v.promo_code_config_id = c.id AND c.tenant_id = :tenantId
          AND v.promo_code_config_id = :promoCodeConfigId AND v.status = 'draft'
        RETURNING v.*`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, promoCodeConfigId, ...data },
        transaction: options.transaction,
      },
    );
    return rows[0] ? toDomain(rows[0]) : null;
  }

  /** The config's own currently-open `draft` version, if any — `null` when there isn't one. */
  async findDraftForConfig(
    tenantId: string,
    promoCodeConfigId: string,
    options: RepositoryOptions = {},
  ): Promise<PromoCodeConfigVersion | null> {
    return this.findByStatus(tenantId, promoCodeConfigId, 'draft', options);
  }

  /** The config's own currently-`published` version, if any — `null` when there isn't one. */
  async findPublishedForConfig(
    tenantId: string,
    promoCodeConfigId: string,
    options: RepositoryOptions = {},
  ): Promise<PromoCodeConfigVersion | null> {
    return this.findByStatus(tenantId, promoCodeConfigId, 'published', options);
  }

  /** Resolves a version by its own `id`, scoped by `tenantId` via a join back to the identity table. */
  async findById(
    tenantId: string,
    versionId: string,
    options: RepositoryOptions = {},
  ): Promise<PromoCodeConfigVersion | null> {
    const rows = await this.sequelize.query<PromoCodeConfigVersionRow>(
      `SELECT v.* FROM promo_code.promo_code_config_version v
         JOIN promo_code.promo_code_config c ON c.id = v.promo_code_config_id
        WHERE v.id = :versionId AND c.tenant_id = :tenantId`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, versionId },
        transaction: options.transaction,
      },
    );
    return rows[0] ? toDomain(rows[0]) : null;
  }

  /**
   * `draft -> published`, in the same statement group T-PC-058's own Implementation note 3
   * requires: the version's own row is locked (`FOR UPDATE`) and checked first — `NOT_FOUND` if
   * `versionId` doesn't resolve for this `(tenantId, promoCodeConfigId)`, `NOT_DRAFT` if it resolves
   * but isn't currently `draft` — then whatever is currently `published` for the config (if
   * anything) is flipped to `deprecated`, and only then is the target flipped to `published`. Always
   * called inside the caller's own transaction (`options.transaction`) — never safe to call
   * standalone, since a crash between the two `UPDATE`s would leave the config with zero published
   * versions.
   */
  async publish(
    tenantId: string,
    promoCodeConfigId: string,
    versionId: string,
    publishedBy: string,
    options: RepositoryOptions = {},
  ): Promise<PublishOutcome> {
    const target = await this.sequelize.query<PromoCodeConfigVersionRow>(
      `SELECT v.* FROM promo_code.promo_code_config_version v
         JOIN promo_code.promo_code_config c ON c.id = v.promo_code_config_id
        WHERE v.id = :versionId AND v.promo_code_config_id = :promoCodeConfigId
          AND c.tenant_id = :tenantId
        FOR UPDATE OF v`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, promoCodeConfigId, versionId },
        transaction: options.transaction,
      },
    );
    if (!target[0]) {
      return { outcome: 'NOT_FOUND' };
    }
    if (target[0].status !== 'draft') {
      return { outcome: 'NOT_DRAFT' };
    }

    await this.sequelize.query(
      `UPDATE promo_code.promo_code_config_version
          SET status = 'deprecated', deprecated_at = now(), updated_at = now()
        WHERE promo_code_config_id = :promoCodeConfigId AND status = 'published'`,
      {
        type: QueryTypes.UPDATE,
        replacements: { promoCodeConfigId },
        transaction: options.transaction,
      },
    );

    const rows = await this.sequelize.query<PromoCodeConfigVersionRow>(
      `UPDATE promo_code.promo_code_config_version
          SET status = 'published', published_by = :publishedBy, published_at = now(),
              updated_at = now()
        WHERE id = :versionId
        RETURNING *`,
      {
        type: QueryTypes.SELECT,
        replacements: { versionId, publishedBy },
        transaction: options.transaction,
      },
    );
    return { outcome: 'PUBLISHED', version: toDomain(rows[0]) };
  }

  private async findByStatus(
    tenantId: string,
    promoCodeConfigId: string,
    status: 'draft' | 'published',
    options: RepositoryOptions,
  ): Promise<PromoCodeConfigVersion | null> {
    const rows = await this.sequelize.query<PromoCodeConfigVersionRow>(
      `SELECT v.* FROM promo_code.promo_code_config_version v
         JOIN promo_code.promo_code_config c ON c.id = v.promo_code_config_id
        WHERE v.promo_code_config_id = :promoCodeConfigId AND c.tenant_id = :tenantId
          AND v.status = :status`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, promoCodeConfigId, status },
        transaction: options.transaction,
      },
    );
    return rows[0] ? toDomain(rows[0]) : null;
  }

  /**
   * Implementation note 3 (mirroring `PromoCodeConfigRepository.translateUniqueViolation`): a
   * `23505` on either `uq_pccv_one_draft` or `uq_pccv_config_version` means "a draft already exists
   * for this config" (the only way either constraint can be hit from `createDraft`'s own insert
   * shape) — surfaced as one typed `DraftAlreadyExistsError`, never the raw driver exception. Any
   * other error is rethrown unchanged.
   */
  private translateDraftConflict(
    error: unknown,
    tenantId: string,
    promoCodeConfigId: string,
  ): unknown {
    const parent = (error as { parent?: { code?: string; constraint?: string } } | undefined)
      ?.parent;
    if (
      parent?.code === PG_UNIQUE_VIOLATION &&
      DRAFT_CONFLICT_CONSTRAINTS.has(parent.constraint ?? '')
    ) {
      return new DraftAlreadyExistsError(tenantId, promoCodeConfigId);
    }
    return error;
  }
}
