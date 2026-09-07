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
 *
 * **T-PC-058 update.** `promo_code_config` split into an identity row (this class's original
 * table, now just `tenantId`/`merchantId`/`name`/`status`) and a versioned
 * `promo_code_config_version` row (every payout/code-generation column, plus the
 * `draft -> published -> deprecated/retired` lifecycle) — see that migration's own header
 * (`T-PC-058_001_split_promo_code_config_version.ts`) for the schema shape. This service now
 * orchestrates both tables:
 *  - `create` writes the identity row plus its first `draft` version, in one transaction.
 *  - `update` (`PATCH /:id`) splits its DTO into identity-editable fields (`name`/`merchantId`,
 *    always directly mutable — they never need a version) and payout fields, which are only ever
 *    applied to the config's own currently-open `draft` version; touching a payout field with no
 *    open draft is rejected (`NoOpenDraftError`), never a silent mutation of a `published` row.
 *  - `createVersion` (`POST /:id/versions`) opens a brand-new `draft` version once the caller
 *    needs to change payout again after the last draft was published.
 *  - `publish` (`POST /:id/versions/:versionId/publish`) transitions a `draft` to `published`,
 *    demoting whatever was previously `published` (if anything) to `deprecated` in the same
 *    transaction.
 * Every write still returns/exposes a single, flattened `PromoCodeConfigDetail` — identity fields
 * plus whichever version (the open draft if one exists, else the currently published one) is the
 * "current" view of the recipe — so a caller never has to separately fetch two rows to see what a
 * write actually did, mirroring the flattened shape the pre-split single-table API returned.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import type { Transaction } from 'sequelize';
import { PROMO_CODE_SEQUELIZE } from './promo-code-config.constants';
import {
  PromoCodeConfigRepository,
  type CreatePromoCodeConfigData,
  type ListPromoCodeConfigsFilter,
  type PromoCodeConfigListItem,
  type UpdatePromoCodeConfigData,
} from './promo-code-config.repository';
import {
  PromoCodeConfigVersionRepository,
  type CreatePromoCodeConfigVersionData,
  type UpdatePromoCodeConfigVersionData,
} from './promo-code-config-version.repository';
import {
  type AuditAction,
  type ChangedFields,
  PromoCodeConfigAuditRepository,
} from './promo-code-config-audit.repository';
import type { PromoCodeConfig } from './promo-code-config.entity';
import type { PromoCodeConfigVersion } from './promo-code-config-version.entity';
import {
  createPromoCodeConfigSchema,
  isValidRewardUnit,
  parseCreatePromoCodeConfigDto,
} from './dto/create-promo-code-config.dto';
import { parseUpdatePromoCodeConfigDto } from './dto/update-promo-code-config.dto';
import { parseCreatePromoCodeConfigVersionDto } from './dto/promo-code-config-version.dto';
import {
  NoOpenDraftError,
  PromoCodeConfigValidationError,
  VersionNotDraftError,
  VersionNotFoundError,
} from './promo-code-config.errors';

/**
 * Loose numeric/string equality: the persisted `reward_value` column comes back from Postgres
 * as a string (`promo-code-config-version.entity.ts`'s header), but an update DTO supplies it as
 * a `number` — comparing them with `!==` would report every no-op update as a "change". Every
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

/** Only the two identity fields a PATCH may ever apply directly to `promo_code_config` itself. */
const IDENTITY_FIELD_KEYS = ['merchantId', 'name'] as const;
/** Every payout/code-generation field — a PATCH may only apply these to an open `draft` version. */
const VERSION_FIELD_KEYS = [
  'codePrefix',
  'codePostfix',
  'codeLength',
  'characterSet',
  'excludeAmbiguousChars',
  'rewardValueType',
  'rewardValue',
  'rewardUnit',
  'maxRedemptionsPerCode',
  'codeExpiryDays',
] as const;

function pick(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = obj[key];
    }
  }
  return result;
}

/**
 * The flattened, single-object view every write/read in this service returns — identity fields
 * plus `currentVersion`/`draftVersion` (the full version rows, for a caller that needs the whole
 * lifecycle picture) and, for convenience/backward-compatibility with the pre-split single-table
 * shape, the payout fields of whichever version is "current" (the open draft if one exists, else
 * the published one) flattened directly onto the top level. Absent entirely (not `null`) when
 * neither a draft nor a published version exists yet — which cannot happen for any row this
 * service itself created, only a theoretical/defensive state.
 */
export interface PromoCodeConfigDetail extends PromoCodeConfig {
  currentVersion: PromoCodeConfigVersion | null;
  draftVersion: PromoCodeConfigVersion | null;
  codePrefix?: string | null;
  codePostfix?: string | null;
  codeLength?: number;
  characterSet?: PromoCodeConfigVersion['characterSet'];
  excludeAmbiguousChars?: boolean;
  rewardValueType?: PromoCodeConfigVersion['rewardValueType'];
  rewardValue?: string;
  rewardUnit?: string;
  maxRedemptionsPerCode?: number;
  codeExpiryDays?: number | null;
  versionNo?: number;
  versionStatus?: PromoCodeConfigVersion['status'];
}

@Injectable()
export class PromoCodeConfigService {
  constructor(
    private readonly repository: PromoCodeConfigRepository,
    private readonly auditRepository: PromoCodeConfigAuditRepository,
    @Inject(PROMO_CODE_SEQUELIZE) private readonly sequelize: Sequelize,
    // T-PC-058. Appended as a 4th, defaulted parameter — never inserted before `sequelize` —
    // specifically so every pre-existing `new PromoCodeConfigService(repository, auditRepository,
    // sequelize)` call site outside this task's own file scope (`test/modules/generation/**`,
    // `agent-promo-generation`'s exclusive scope, R8) keeps compiling unchanged. NestJS's own DI
    // still resolves this param normally from `PromoCodeConfigModule`'s providers (`design:
    // paramtypes` reflection captures every parameter's type regardless of a default expression);
    // the default only ever fires for a plain `new` call that omits this argument.
    private readonly versionRepository: PromoCodeConfigVersionRepository = new PromoCodeConfigVersionRepository(
      sequelize,
    ),
  ) {}

  async create(tenantId: string, input: unknown, actorId: string): Promise<PromoCodeConfigDetail> {
    const dto = parseCreatePromoCodeConfigDto(input);
    const identityData: CreatePromoCodeConfigData = {
      merchantId: dto.merchantId ?? null,
      name: dto.name,
      createdBy: actorId,
    };
    const versionData: CreatePromoCodeConfigVersionData = {
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
      const created = await this.repository.create(tenantId, identityData, { transaction });
      const draft = await this.versionRepository.createDraft(tenantId, created.id, versionData, {
        transaction,
      });
      if (!draft) {
        // Defensive only (R3) — `created.id` was just returned by the INSERT above, inside the
        // same transaction, so the version's own tenant-scoped lookup can never miss it.
        throw new Error(`Failed to create the initial draft version for "${created.id}"`);
      }
      await this.writeAudit(
        created.id,
        'CREATE',
        buildDiff(undefined, { ...identityData, ...versionData } as unknown as Record<
          string,
          unknown
        >),
        actorId,
        transaction,
      );
      return this.toDetail(created, draft, null);
    });
  }

  /** Identity-only lookup — the shape `CampaignBindingService`/`PromoCodeGenerationService`
   * (outside this module) consume, needing only `.status`. */
  async findById(tenantId: string, id: string): Promise<PromoCodeConfig | null> {
    return this.repository.findById(tenantId, id);
  }

  /** The flattened detail shape — identity plus whichever version is "current" (§ this file's own header). */
  async findDetail(tenantId: string, id: string): Promise<PromoCodeConfigDetail | null> {
    const config = await this.repository.findById(tenantId, id);
    if (!config) return null;
    const [draft, published] = await Promise.all([
      this.versionRepository.findDraftForConfig(tenantId, id),
      this.versionRepository.findPublishedForConfig(tenantId, id),
    ]);
    return this.toDetail(config, draft, published);
  }

  async list(
    tenantId: string,
    filter: ListPromoCodeConfigsFilter = {},
  ): Promise<PromoCodeConfig[]> {
    return this.repository.list(tenantId, filter);
  }

  /** `04-API-CONTRACT.md` §1's thin, list-facing shape (T-PC-011's controller). */
  async listSummaries(
    tenantId: string,
    filter: ListPromoCodeConfigsFilter = {},
  ): Promise<PromoCodeConfigListItem[]> {
    return this.repository.listSummaries(tenantId, filter);
  }

  /**
   * Returns `null` when `id` doesn't resolve to a row owned by `tenantId` — a spoofed/mismatched
   * `tenantId` never applies an update, it just looks identical to "not found" (TC-13), the same
   * property `findById` already guarantees at the repository layer.
   *
   * Splits the parsed DTO into identity-editable fields (`name`/`merchantId`, always directly
   * mutable) and payout fields (only ever applied to the currently-open `draft` version) —
   * touching a payout field with no open draft throws `NoOpenDraftError` (implementation note 3),
   * never a silent mutation of a `published` row.
   */
  async update(
    tenantId: string,
    id: string,
    input: unknown,
    actorId: string,
  ): Promise<PromoCodeConfigDetail | null> {
    const dto = parseUpdatePromoCodeConfigDto(input);
    const existing = await this.repository.findById(tenantId, id);
    if (!existing) return null;

    const identityFields = pick(
      dto as unknown as Record<string, unknown>,
      IDENTITY_FIELD_KEYS,
    ) as UpdatePromoCodeConfigData;
    const versionFields = pick(
      dto as unknown as Record<string, unknown>,
      VERSION_FIELD_KEYS,
    ) as UpdatePromoCodeConfigVersionData;

    const draft = await this.versionRepository.findDraftForConfig(tenantId, id);
    if (Object.keys(versionFields).length > 0) {
      if (!draft) {
        throw new NoOpenDraftError(tenantId, id);
      }
      this.assertRewardUnitStillLegal(versionFields, draft);
    }

    const identityDiff = buildDiff(existing as unknown as Record<string, unknown>, identityFields);
    const versionDiff = draft
      ? buildDiff(draft as unknown as Record<string, unknown>, versionFields)
      : {};
    const changedFields: ChangedFields = { ...identityDiff, ...versionDiff };

    if (Object.keys(changedFields).length === 0) {
      // Nothing actually changed — no-op, no audit row (implementation note 5 only requires
      // an audit entry for a real change; a resubmitted-but-identical PATCH isn't one).
      const published = await this.versionRepository.findPublishedForConfig(tenantId, id);
      return this.toDetail(existing, draft, published);
    }

    return this.sequelize.transaction(async (transaction) => {
      let updatedConfig = existing;
      if (Object.keys(identityDiff).length > 0) {
        const result = await this.repository.update(tenantId, id, identityFields, actorId, {
          transaction,
        });
        if (!result) return null;
        updatedConfig = result;
      }

      let updatedDraft = draft;
      if (draft && Object.keys(versionDiff).length > 0) {
        updatedDraft = await this.versionRepository.updateDraft(tenantId, id, versionFields, {
          transaction,
        });
      }

      await this.writeAudit(id, 'UPDATE', changedFields, actorId, transaction);
      const published = await this.versionRepository.findPublishedForConfig(tenantId, id, {
        transaction,
      });
      return this.toDetail(updatedConfig, updatedDraft, published);
    });
  }

  /**
   * `POST /:id/versions` — opens a brand-new `draft` version for an already-existing config
   * (implementation note 3: "the caller must first create one" once the prior draft has been
   * published and payout needs to change again). Rejects with `DraftAlreadyExistsError`
   * (thrown directly by the repository, `uq_pccv_one_draft`) if one is already open.
   */
  async createVersion(
    tenantId: string,
    id: string,
    input: unknown,
    actorId: string,
  ): Promise<PromoCodeConfigDetail | null> {
    const config = await this.repository.findById(tenantId, id);
    if (!config) return null;
    const dto = parseCreatePromoCodeConfigVersionDto(input);
    const versionData: CreatePromoCodeConfigVersionData = {
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
      const draft = await this.versionRepository.createDraft(tenantId, id, versionData, {
        transaction,
      });
      if (!draft) return null;
      await this.writeAudit(
        id,
        'CREATE',
        buildDiff(undefined, versionData as unknown as Record<string, unknown>),
        actorId,
        transaction,
      );
      const published = await this.versionRepository.findPublishedForConfig(tenantId, id, {
        transaction,
      });
      return this.toDetail(config, draft, published);
    });
  }

  /**
   * `POST /:id/versions/:versionId/publish` — `draft -> published`, demoting whatever was
   * previously `published` (if anything) to `deprecated` in the same transaction (implementation
   * note 3, TC-4). Throws `VersionNotFoundError`/`VersionNotDraftError` rather than returning a
   * value the caller could mistake for success — this is a state-changing action, not a lookup.
   */
  async publish(
    tenantId: string,
    id: string,
    versionId: string,
    actorId: string,
  ): Promise<PromoCodeConfigDetail | null> {
    const config = await this.repository.findById(tenantId, id);
    if (!config) return null;

    return this.sequelize.transaction(async (transaction) => {
      const result = await this.versionRepository.publish(tenantId, id, versionId, actorId, {
        transaction,
      });
      if (result.outcome === 'NOT_FOUND') {
        throw new VersionNotFoundError(tenantId, id, versionId);
      }
      if (result.outcome === 'NOT_DRAFT') {
        throw new VersionNotDraftError(tenantId, id, versionId);
      }
      await this.writeAudit(
        id,
        'UPDATE',
        {
          versionStatus: { old: 'draft', new: 'published' },
          versionNo: { old: null, new: result.version.versionNo },
        },
        actorId,
        transaction,
      );
      return this.toDetail(config, null, result.version);
    });
  }

  /**
   * Soft-archive (implementation note 4): sets `status = 'ARCHIVED'`, never deletes the row.
   * Idempotent — archiving an already-`ARCHIVED` config is a safe no-op, not a second audit row.
   * Identity-level only — never touches any version row's own lifecycle.
   */
  async archive(
    tenantId: string,
    id: string,
    actorId: string,
  ): Promise<PromoCodeConfigDetail | null> {
    const existing = await this.repository.findById(tenantId, id);
    if (!existing) return null;
    if (existing.status === 'ARCHIVED') {
      const [draft, published] = await Promise.all([
        this.versionRepository.findDraftForConfig(tenantId, id),
        this.versionRepository.findPublishedForConfig(tenantId, id),
      ]);
      return this.toDetail(existing, draft, published);
    }

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
      const [draft, published] = await Promise.all([
        this.versionRepository.findDraftForConfig(tenantId, id, { transaction }),
        this.versionRepository.findPublishedForConfig(tenantId, id, { transaction }),
      ]);
      return this.toDetail(archived, draft, published);
    });
  }

  private assertRewardUnitStillLegal(
    dto: { rewardValueType?: string; rewardUnit?: string },
    existingDraft: PromoCodeConfigVersion,
  ): void {
    if (dto.rewardValueType === undefined && dto.rewardUnit === undefined) return;
    const effectiveType = dto.rewardValueType ?? existingDraft.rewardValueType;
    const effectiveUnit = dto.rewardUnit ?? existingDraft.rewardUnit;
    if (!isValidRewardUnit(effectiveType, effectiveUnit)) {
      throw new PromoCodeConfigValidationError([
        {
          path: 'rewardUnit',
          message: `"${effectiveUnit}" is not a legal rewardUnit for rewardValueType "${effectiveType}"`,
        },
      ]);
    }
  }

  private toDetail(
    config: PromoCodeConfig,
    draftVersion: PromoCodeConfigVersion | null,
    currentVersion: PromoCodeConfigVersion | null,
  ): PromoCodeConfigDetail {
    const flattenSource = draftVersion ?? currentVersion;
    return {
      ...config,
      currentVersion,
      draftVersion,
      ...(flattenSource
        ? {
            codePrefix: flattenSource.codePrefix,
            codePostfix: flattenSource.codePostfix,
            codeLength: flattenSource.codeLength,
            characterSet: flattenSource.characterSet,
            excludeAmbiguousChars: flattenSource.excludeAmbiguousChars,
            rewardValueType: flattenSource.rewardValueType,
            rewardValue: flattenSource.rewardValue,
            rewardUnit: flattenSource.rewardUnit,
            maxRedemptionsPerCode: flattenSource.maxRedemptionsPerCode,
            codeExpiryDays: flattenSource.codeExpiryDays,
            versionNo: flattenSource.versionNo,
            versionStatus: flattenSource.status,
          }
        : {}),
    };
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
