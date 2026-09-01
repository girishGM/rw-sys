/**
 * T-PC-010. `promo_code_config` CRUD — create/update/archive/list business logic. This is the
 * single place the REST layer (T-PC-011) and the bind API (T-PC-012) both read and write this
 * table through (this task's Objective); it is never bypassed by either.
 *
 * DTO parsing happens **here**, not in a controller — this task owns "guarantee a config is
 * structurally valid" (implementation note 3) end to end, so `create`/`update` accept an
 * `unknown` request body and parse it themselves. A future REST controller (T-PC-011) is then
 * a thin adapter: forward `req.body`, translate the typed errors this service throws
 * (`PromoCodeConfigValidationError` → 400, `ConfigNameConflictError` → 409) to HTTP status
 * codes, and nothing else.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import type { Transaction } from 'sequelize';
import { PROMO_CODE_SEQUELIZE } from './promo-code-config.constants';
import {
  PromoCodeConfigRepository,
  type CreatePromoCodeConfigData,
  type ListPromoCodeConfigsFilter,
  type UpdatePromoCodeConfigData,
} from './promo-code-config.repository';
import {
  type AuditAction,
  type ChangedFields,
  PromoCodeConfigAuditRepository,
} from './promo-code-config-audit.repository';
import type { PromoCodeConfig } from './promo-code-config.entity';
import {
  createPromoCodeConfigSchema,
  isValidRewardUnit,
  parseCreatePromoCodeConfigDto,
} from './dto/create-promo-code-config.dto';
import { parseUpdatePromoCodeConfigDto } from './dto/update-promo-code-config.dto';
import { PromoCodeConfigValidationError } from './promo-code-config.errors';

/**
 * Loose numeric/string equality: the persisted `reward_value` column comes back from Postgres
 * as a string (`promo-code-config.entity.ts`'s header), but an update DTO supplies it as a
 * `number` — comparing them with `!==` would report every no-op update as a "change". Every
 * other touched field is a plain string/boolean/null, where `===` is exactly right.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'number' || typeof b === 'number') {
    const numA = typeof a === 'number' ? a : Number(a);
    const numB = typeof b === 'number' ? b : Number(b);
    if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA === numB;
  }
  return false;
}

/**
 * Diff-shaped audit payload (implementation note 5): only keys present in `candidate` are
 * considered, and a key is included only when its value actually differs from `before` — or,
 * for a brand-new row (`before` is `undefined`), every candidate key is included with
 * `old: null`.
 */
function buildDiff(
  before: Record<string, unknown> | undefined,
  candidate: Record<string, unknown>,
): ChangedFields {
  const diff: ChangedFields = {};
  for (const key of Object.keys(candidate)) {
    const newValue = candidate[key];
    if (before === undefined) {
      diff[key] = { old: null, new: newValue };
      continue;
    }
    const oldValue = before[key];
    if (!valuesEqual(oldValue, newValue)) {
      diff[key] = { old: oldValue, new: newValue };
    }
  }
  return diff;
}

@Injectable()
export class PromoCodeConfigService {
  constructor(
    private readonly repository: PromoCodeConfigRepository,
    private readonly auditRepository: PromoCodeConfigAuditRepository,
    @Inject(PROMO_CODE_SEQUELIZE) private readonly sequelize: Sequelize,
  ) {}

  async create(tenantId: string, input: unknown, actorId: string): Promise<PromoCodeConfig> {
    const dto = parseCreatePromoCodeConfigDto(input);
    const data: CreatePromoCodeConfigData = {
      merchantId: dto.merchantId ?? null,
      name: dto.name,
      codePrefix: dto.codePrefix ?? null,
      codePostfix: dto.codePostfix ?? null,
      codeLength: dto.codeLength,
      characterSet: dto.characterSet,
      excludeAmbiguousChars: dto.excludeAmbiguousChars,
      rewardValueType: dto.rewardValueType,
      rewardValue: dto.rewardValue,
      rewardUnit: dto.rewardUnit,
      maxRedemptionsPerCode: dto.maxRedemptionsPerCode,
      codeExpiryDays: dto.codeExpiryDays ?? null,
      createdBy: actorId,
    };

    return this.sequelize.transaction(async (transaction) => {
      const created = await this.repository.create(tenantId, data, { transaction });
      await this.writeAudit(
        created.id,
        'CREATE',
        buildDiff(undefined, data as unknown as Record<string, unknown>),
        actorId,
        transaction,
      );
      return created;
    });
  }

  async findById(tenantId: string, id: string): Promise<PromoCodeConfig | null> {
    return this.repository.findById(tenantId, id);
  }

  async list(
    tenantId: string,
    filter: ListPromoCodeConfigsFilter = {},
  ): Promise<PromoCodeConfig[]> {
    return this.repository.list(tenantId, filter);
  }

  /**
   * Returns `null` when `id` doesn't resolve to a row owned by `tenantId` — a spoofed/mismatched
   * `tenantId` never applies an update, it just looks identical to "not found" (TC-13), the same
   * property `findById` already guarantees at the repository layer.
   */
  async update(
    tenantId: string,
    id: string,
    input: unknown,
    actorId: string,
  ): Promise<PromoCodeConfig | null> {
    const dto = parseUpdatePromoCodeConfigDto(input);
    const existing = await this.repository.findById(tenantId, id);
    if (!existing) return null;

    this.assertRewardUnitStillLegal(dto, existing);

    const diff = buildDiff(existing as unknown as Record<string, unknown>, dto);
    const changedFields = Object.keys(diff);
    if (changedFields.length === 0) {
      // Nothing actually changed — no-op, no audit row (implementation note 5 only requires
      // an audit entry for a real change; a resubmitted-but-identical PATCH isn't one).
      return existing;
    }
    const changedData = Object.fromEntries(
      changedFields.map((field) => [field, (dto as Record<string, unknown>)[field]]),
    ) as UpdatePromoCodeConfigData;

    return this.sequelize.transaction(async (transaction) => {
      const updated = await this.repository.update(tenantId, id, changedData, actorId, {
        transaction,
      });
      if (!updated) return null;
      await this.writeAudit(id, 'UPDATE', diff, actorId, transaction);
      return updated;
    });
  }

  /**
   * Soft-archive (implementation note 4): sets `status = 'ARCHIVED'`, never deletes the row.
   * Idempotent — archiving an already-`ARCHIVED` config is a safe no-op, not a second audit row.
   */
  async archive(tenantId: string, id: string, actorId: string): Promise<PromoCodeConfig | null> {
    const existing = await this.repository.findById(tenantId, id);
    if (!existing) return null;
    if (existing.status === 'ARCHIVED') return existing;

    return this.sequelize.transaction(async (transaction) => {
      const archived = await this.repository.archive(tenantId, id, actorId, { transaction });
      if (!archived) return null;
      await this.writeAudit(
        id,
        'ARCHIVE',
        { status: { old: existing.status, new: 'ARCHIVED' } },
        actorId,
        transaction,
      );
      return archived;
    });
  }

  private assertRewardUnitStillLegal(
    dto: { rewardValueType?: string; rewardUnit?: string },
    existing: PromoCodeConfig,
  ): void {
    if (dto.rewardValueType === undefined && dto.rewardUnit === undefined) return;
    const effectiveType = dto.rewardValueType ?? existing.rewardValueType;
    const effectiveUnit = dto.rewardUnit ?? existing.rewardUnit;
    if (!isValidRewardUnit(effectiveType, effectiveUnit)) {
      throw new PromoCodeConfigValidationError([
        {
          path: 'rewardUnit',
          message: `"${effectiveUnit}" is not a legal rewardUnit for rewardValueType "${effectiveType}"`,
        },
      ]);
    }
  }

  private async writeAudit(
    promoCodeConfigId: string,
    action: AuditAction,
    changedFields: ChangedFields,
    changedBy: string,
    transaction: Transaction,
  ): Promise<void> {
    await this.auditRepository.record(
      { promoCodeConfigId, action, changedFields, changedBy },
      { transaction },
    );
  }
}

// Re-exported so callers (T-PC-011's controller) can validate a raw request body shape ahead
// of calling `create` if they need a 400 before touching this service at all (e.g. a bulk
// import screen validating N rows up front) — the schema itself stays the single source of
// truth either way.
export { createPromoCodeConfigSchema };
