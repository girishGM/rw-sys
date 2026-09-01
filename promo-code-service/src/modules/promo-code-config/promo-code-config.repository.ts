/**
 * T-PC-010. Scoped repository for `promo_code.promo_code_config` — every method takes
 * `tenantId` as a mandatory first-class parameter and bakes it into the `WHERE` clause itself
 * (AGENT-PROTOCOL.md R2 / this task's implementation note 1): there is no `findById(id)` that
 * returns a row without a `tenantId` argument, only `findById(tenantId, id)`, so an accidental
 * cross-tenant read is a type error, not a code-review catch.
 *
 * Talks to Postgres with parameterised `sequelize.query(...)` — this project's migrations are
 * raw SQL, not `sequelize-typescript` `@Table` models (see `promo-code-config.entity.ts`'s own
 * header), so the repository stays consistent with that convention rather than introducing a
 * second, ORM-model-based way of describing the same table.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import type { Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';
import { PROMO_CODE_SEQUELIZE } from './promo-code-config.constants';
import { ConfigNameConflictError } from './promo-code-config.errors';
import type {
  CharacterSet,
  PromoCodeConfig,
  PromoCodeConfigRow,
  PromoCodeConfigStatus,
  RewardValueType,
} from './promo-code-config.entity';
import { toDomain } from './promo-code-config.entity';

export interface CreatePromoCodeConfigData {
  merchantId: string | null;
  name: string;
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
export type UpdatePromoCodeConfigData = Partial<Omit<CreatePromoCodeConfigData, 'createdBy'>>;

export interface ListPromoCodeConfigsFilter {
  merchantId?: string;
  status?: PromoCodeConfigStatus;
}

export interface RepositoryOptions {
  transaction?: Transaction;
}

const COLUMN_BY_FIELD: Record<keyof UpdatePromoCodeConfigData, string> = {
  merchantId: 'merchant_id',
  name: 'name',
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

@Injectable()
export class PromoCodeConfigRepository {
  constructor(@Inject(PROMO_CODE_SEQUELIZE) private readonly sequelize: Sequelize) {}

  async create(
    tenantId: string,
    data: CreatePromoCodeConfigData,
    options: RepositoryOptions = {},
  ): Promise<PromoCodeConfig> {
    try {
      const [row] = await this.sequelize.query<PromoCodeConfigRow>(
        `INSERT INTO promo_code.promo_code_config
           (tenant_id, merchant_id, name, code_prefix, code_postfix, code_length,
            character_set, exclude_ambiguous_chars, reward_value_type, reward_value,
            reward_unit, max_redemptions_per_code, code_expiry_days, created_by, updated_by)
         VALUES
           (:tenantId, :merchantId, :name, :codePrefix, :codePostfix, :codeLength,
            :characterSet, :excludeAmbiguousChars, :rewardValueType, :rewardValue,
            :rewardUnit, :maxRedemptionsPerCode, :codeExpiryDays, :createdBy, :createdBy)
         RETURNING *`,
        {
          type: QueryTypes.SELECT,
          replacements: { tenantId, ...data },
          transaction: options.transaction,
        },
      );
      return toDomain(row);
    } catch (error) {
      throw this.translateUniqueViolation(error, tenantId, data.name);
    }
  }

  async findById(
    tenantId: string,
    id: string,
    options: RepositoryOptions = {},
  ): Promise<PromoCodeConfig | null> {
    const rows = await this.sequelize.query<PromoCodeConfigRow>(
      `SELECT * FROM promo_code.promo_code_config
         WHERE id = :id AND tenant_id = :tenantId AND deleted_at IS NULL`,
      {
        type: QueryTypes.SELECT,
        replacements: { id, tenantId },
        transaction: options.transaction,
      },
    );
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async list(
    tenantId: string,
    filter: ListPromoCodeConfigsFilter = {},
    options: RepositoryOptions = {},
  ): Promise<PromoCodeConfig[]> {
    const status = filter.status ?? 'ACTIVE';
    // Tenant-wide configs (merchant_id IS NULL) are always included; a merchant-scoped
    // caller additionally sees that merchant's own configs (01-DATABASE.md §1, TC-10/TC-11).
    const merchantClause = filter.merchantId
      ? '(merchant_id IS NULL OR merchant_id = :merchantId)'
      : 'merchant_id IS NULL';
    const rows = await this.sequelize.query<PromoCodeConfigRow>(
      `SELECT * FROM promo_code.promo_code_config
         WHERE tenant_id = :tenantId AND status = :status AND deleted_at IS NULL
           AND ${merchantClause}
         ORDER BY name ASC`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, status, merchantId: filter.merchantId ?? null },
        transaction: options.transaction,
      },
    );
    return rows.map(toDomain);
  }

  async update(
    tenantId: string,
    id: string,
    data: UpdatePromoCodeConfigData,
    updatedBy: string,
    options: RepositoryOptions = {},
  ): Promise<PromoCodeConfig | null> {
    const fields = Object.keys(data) as Array<keyof UpdatePromoCodeConfigData>;
    if (fields.length === 0) {
      return this.findById(tenantId, id, options);
    }
    const setClause = fields.map((field) => `${COLUMN_BY_FIELD[field]} = :${field}`).join(', ');
    try {
      const rows = await this.sequelize.query<PromoCodeConfigRow>(
        `UPDATE promo_code.promo_code_config
           SET ${setClause}, updated_by = :updatedBy, updated_at = now()
           WHERE id = :id AND tenant_id = :tenantId AND deleted_at IS NULL
           RETURNING *`,
        {
          type: QueryTypes.SELECT,
          replacements: { id, tenantId, updatedBy, ...data },
          transaction: options.transaction,
        },
      );
      return rows[0] ? toDomain(rows[0]) : null;
    } catch (error) {
      throw this.translateUniqueViolation(error, tenantId, (data.name as string) ?? '');
    }
  }

  async archive(
    tenantId: string,
    id: string,
    updatedBy: string,
    options: RepositoryOptions = {},
  ): Promise<PromoCodeConfig | null> {
    const rows = await this.sequelize.query<PromoCodeConfigRow>(
      `UPDATE promo_code.promo_code_config
         SET status = 'ARCHIVED', updated_by = :updatedBy, updated_at = now()
         WHERE id = :id AND tenant_id = :tenantId AND deleted_at IS NULL
         RETURNING *`,
      {
        type: QueryTypes.SELECT,
        replacements: { id, tenantId, updatedBy },
        transaction: options.transaction,
      },
    );
    return rows[0] ? toDomain(rows[0]) : null;
  }

  /**
   * Implementation note 6: a `(tenant_id, name)` unique-violation surfaces as
   * `ConfigNameConflictError`, never a raw `SequelizeUniqueConstraintError`/driver error.
   * Keyed off the real Postgres error code (`23505`) and constraint name, not a message
   * substring match, so a driver-message wording change can't silently defeat this.
   */
  private translateUniqueViolation(error: unknown, tenantId: string, name: string): unknown {
    const parent = (error as { parent?: { code?: string; constraint?: string } } | undefined)
      ?.parent;
    if (
      parent?.code === PG_UNIQUE_VIOLATION &&
      parent?.constraint === 'uc_promo_code_config_name'
    ) {
      return new ConfigNameConflictError(tenantId, name);
    }
    return error;
  }
}
