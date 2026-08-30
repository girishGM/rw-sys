/**
 * T-041 — `/rewards/:id/versions`: the reward-side mirror of `RuleVersionsService`, over
 * `reward_systems`/`reward_versions` (06-VERSIONING.md §5.1/§9 — "Reward equivalents mirror
 * these exactly"). See that file's own header for the three-layer authority story and the
 * `assertRole`/scope reasoning, identical here.
 *
 * `connectorConfig` is diffed by top-level key (`diffFlatObjectKeys`), the documented stand-in
 * for a rule's `parameters.fields` — `version-diff.util.ts`'s own header explains the mapping.
 *
 * ### T-119 — Kind and value config
 *
 * `reward_kind`/`value_config` (13-REWARD-MASTER-VALUE-SOURCES.md §5) are accepted on create and
 * on draft update, cloned into a new draft exactly like the connector payload, and returned on
 * every read. Three properties this file is responsible for:
 *
 *  1. **The pair is validated together, against the *effective* pair.** A `PATCH` may send only
 *     one half, so the other is read from the stored draft before
 *     {@link isRewardVersionValue} judges it — a check `class-validator` cannot make on the DTO
 *     alone, since it never sees the row.
 *  2. **A `value_config` with no Kind is refused** (400): there is no schema to judge it by.
 *  3. **Immutability once published is the database's job, not this file's.** `updateDraft` does
 *     refuse a non-draft first (409, and it did so long before this task), but the guarantee that
 *     matters is `fn_reward_version_immutable()` (`T119_002`), which also holds for an `UPDATE`
 *     that never passes through this service at all.
 */
import { Inject, Injectable } from '@nestjs/common';
import { UniqueConstraintError } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { isRewardVersionValue, type RewardKind } from '@reward-portal/shared';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ValidationFailedError } from '@/common/errors/app-error';
import {
  Country,
  RewardSystem,
  RewardVersion,
  RewardVersionCountryAssignment,
} from '@/database/models';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { PortalUser } from '@/database/portal-models';
import { assertRole } from '@/common/rbac/assert-role';
import { AuditService } from '@/common/audit/audit.service';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { diffFlatObjectKeys, suggestIsBreaking } from './version-diff.util';
import { findActiveCampaignsUsingRewardVersionInCountry } from './version-campaign-usage.query';
import type { CreateRewardVersionDto } from './dto/create-reward-version.dto';
import type { UpdateRewardVersionDto } from './dto/update-reward-version.dto';
import {
  toRewardVersionDto,
  toRewardVersionCountryAssignmentDto,
  toVersionDiffDto,
  type RewardVersionDto,
  type VersionCountryAssignmentDto,
  type VersionDiffDto,
} from './dto/version-response.dto';
import {
  VersionBreakingConfirmationRequiredError,
  VersionDraftAlreadyExistsError,
  VersionHasCampaignsError,
  VersionInvalidTransitionError,
} from './versions.errors';

/**
 * T-119 — a `RewardVersionDto` plus the Kind/value pair, composed here rather than added to
 * `toRewardVersionDto()` itself: `dto/version-response.dto.ts` is owned by T-109, which is still
 * in flight, and R9 forbids editing another task's owned files. Composition costs one spread and
 * keeps both tasks' changes independent; `packages/shared`'s `rewardVersionSchema` (the contract
 * a client actually validates against) carries the same two keys, which is what makes this a
 * shape and not a local convenience.
 */
export interface RewardVersionWithValueDto extends RewardVersionDto {
  readonly rewardKind: RewardKind | null;
  readonly valueConfig: Record<string, unknown> | null;
}

function toRewardVersionWithValueDto(
  version: RewardVersion,
  suggestedIsBreaking: boolean | null,
): RewardVersionWithValueDto {
  return {
    ...toRewardVersionDto(version, suggestedIsBreaking),
    rewardKind: version.rewardKind,
    valueConfig: version.valueConfig,
  };
}

@Injectable()
export class RewardVersionsService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly audit: AuditService,
  ) {}

  // --- reads -----------------------------------------------------------------------------

  async list(rewardId: number): Promise<readonly RewardVersionWithValueDto[]> {
    await this.findRewardOrFail(rewardId);
    const versions = await this.scoped.listAll(RewardVersion, {
      where: { rewardId },
      order: [['versionNo', 'DESC']],
    });
    const byId = new Map(versions.map((version) => [version.id, version]));
    return versions.map((version) =>
      toRewardVersionWithValueDto(version, this.computeSuggestion(version, byId)),
    );
  }

  async getById(rewardId: number, versionId: number): Promise<RewardVersionWithValueDto> {
    const version = await this.findVersionOrFail(rewardId, versionId);
    return toRewardVersionWithValueDto(version, await this.suggestionFor(version));
  }

  async diff(rewardId: number, versionId: number, otherVersionId: number): Promise<VersionDiffDto> {
    const version = await this.findVersionOrFail(rewardId, versionId);
    const other = await this.findVersionOrFail(rewardId, otherVersionId);
    const fieldDiff = diffFlatObjectKeys(version.connectorConfig, other.connectorConfig);

    return toVersionDiffDto({
      versionId: version.id,
      otherVersionId: other.id,
      versionNo: version.versionNo,
      otherVersionNo: other.versionNo,
      expressionChanged: version.deliveryMode !== other.deliveryMode,
      diff: fieldDiff,
      suggestedIsBreaking: suggestIsBreaking(fieldDiff),
    });
  }

  async listCountryAssignments(
    rewardId: number,
    versionId: number,
  ): Promise<readonly VersionCountryAssignmentDto[]> {
    await this.findVersionOrFail(rewardId, versionId);
    const rows = await this.scoped.listAll(RewardVersionCountryAssignment, {
      where: { rewardVersionId: versionId },
      include: [Country, RewardVersion],
      order: [['assignedAt', 'ASC']],
    });
    return rows.map((row) =>
      toRewardVersionCountryAssignmentDto(
        row as RewardVersionCountryAssignment & { country: Country; rewardVersion: RewardVersion },
      ),
    );
  }

  // --- writes ------------------------------------------------------------------------------

  async createDraft(
    actor: AuthenticatedUser,
    rewardId: number,
    dto: CreateRewardVersionDto,
  ): Promise<RewardVersionWithValueDto> {
    assertRole(actor, 'super_admin');
    const reward = await this.findRewardOrFail(rewardId);

    const existingDraftCount = await this.scoped.count(RewardVersion, {
      where: { rewardId, status: 'draft' },
    });
    if (existingDraftCount > 0) throw new VersionDraftAlreadyExistsError();

    const latestPublished = await this.latestPublishedVersion(rewardId);
    const nextVersionNo = await this.nextVersionNo(rewardId);
    const createdBy = await this.resolveAdminUserId(actor);

    const basePayload =
      latestPublished === null
        ? {
            connectorConfig: reward.connectorConfig,
            deliveryMode: reward.deliveryMode,
            retryConfig: reward.retryConfig,
            policiesSnapshot: null,
            unitType: null,
            unitCode: null,
            // `reward_systems` has no Kind of its own (§1: Kind lives on the version pair), so a
            // bootstrapped v1 starts with none — "kind not yet set", exactly TC-7's state.
            rewardKind: null,
            valueConfig: null,
          }
        : {
            connectorConfig: latestPublished.connectorConfig,
            deliveryMode: latestPublished.deliveryMode,
            retryConfig: latestPublished.retryConfig,
            policiesSnapshot: latestPublished.policiesSnapshot,
            unitType: latestPublished.unitType,
            unitCode: latestPublished.unitCode,
            rewardKind: latestPublished.rewardKind,
            valueConfig: latestPublished.valueConfig,
          };

    // T-119 — a caller-supplied Kind overrides the clone; the pair is validated as a whole,
    // whichever half each side contributed.
    const rewardKind = dto.rewardKind === undefined ? basePayload.rewardKind : dto.rewardKind;
    const valueConfig = dto.valueConfig === undefined ? basePayload.valueConfig : dto.valueConfig;
    this.assertRewardValue(rewardKind, valueConfig);

    let created: RewardVersion;
    try {
      created = await this.scoped.create(RewardVersion, {
        rewardId,
        versionNo: nextVersionNo,
        ...basePayload,
        rewardKind,
        valueConfig,
        changeSummary: dto.changeSummary ?? null,
        isBreaking: false,
        status: 'draft',
        supersedesVersionId: latestPublished?.id ?? null,
        originRequestId: dto.originRequestId ?? null,
        // See `RuleVersionsService.createDraft`'s comment — no `admin_users` FK on this column.
        createdBy: createdBy ?? actor.userId,
      } as never);
    } catch (error) {
      if (error instanceof UniqueConstraintError)
        throw new VersionDraftAlreadyExistsError({ cause: error });
      throw error;
    }

    this.audit.annotate({
      targetId: created.id,
      targetType: 'reward_version',
      detail: { rewardId, versionNo: created.versionNo, rewardKind },
    });
    return toRewardVersionWithValueDto(created, latestPublished === null ? null : false);
  }

  async updateDraft(
    actor: AuthenticatedUser,
    rewardId: number,
    versionId: number,
    dto: UpdateRewardVersionDto,
  ): Promise<RewardVersionWithValueDto> {
    assertRole(actor, 'super_admin');
    const before = await this.findVersionOrFail(rewardId, versionId);
    if (before.status !== 'draft') throw new VersionInvalidTransitionError();

    // T-119 — the effective pair: whichever half this request omits is the half already stored.
    if (dto.rewardKind !== undefined || dto.valueConfig !== undefined) {
      this.assertRewardValue(
        dto.rewardKind === undefined ? before.rewardKind : dto.rewardKind,
        dto.valueConfig === undefined ? before.valueConfig : dto.valueConfig,
      );
    }

    const changes: Record<string, unknown> = {};
    if (dto.connectorConfig !== undefined) changes['connectorConfig'] = dto.connectorConfig;
    if (dto.deliveryMode !== undefined) changes['deliveryMode'] = dto.deliveryMode;
    if (dto.retryConfig !== undefined) changes['retryConfig'] = dto.retryConfig;
    if (dto.policiesSnapshot !== undefined) changes['policiesSnapshot'] = dto.policiesSnapshot;
    if (dto.unitType !== undefined) changes['unitType'] = dto.unitType;
    if (dto.unitCode !== undefined) changes['unitCode'] = dto.unitCode;
    if (dto.rewardKind !== undefined) changes['rewardKind'] = dto.rewardKind;
    if (dto.valueConfig !== undefined) changes['valueConfig'] = dto.valueConfig;
    if (dto.changeSummary !== undefined) changes['changeSummary'] = dto.changeSummary;

    if (dto.isBreaking !== undefined) {
      const nextConfig = dto.connectorConfig ?? before.connectorConfig;
      const supersedes = await this.loadSupersedes(before);
      const fieldDiff = diffFlatObjectKeys(supersedes?.connectorConfig ?? null, nextConfig);
      const suggested = suggestIsBreaking(fieldDiff);
      if (dto.isBreaking !== suggested && dto.confirmBreakingOverride !== true) {
        throw new VersionBreakingConfirmationRequiredError(suggested);
      }
      changes['isBreaking'] = dto.isBreaking;
    }

    if (Object.keys(changes).length > 0) {
      const affected = await this.scoped.update(RewardVersion, changes, {
        where: { id: versionId, rewardId, status: 'draft' },
      });
      if (affected === 0) throw new VersionInvalidTransitionError();
    }

    const after = await this.findVersionOrFail(rewardId, versionId);
    this.audit.annotate({
      targetId: versionId,
      targetType: 'reward_version',
      detail: { changes: this.audit.diffFields(fieldSnapshot(before), fieldSnapshot(after)) },
    });
    return toRewardVersionWithValueDto(after, await this.suggestionFor(after));
  }

  async publish(
    actor: AuthenticatedUser,
    rewardId: number,
    versionId: number,
  ): Promise<RewardVersionWithValueDto> {
    assertRole(actor, 'super_admin');
    const version = await this.findVersionOrFail(rewardId, versionId);
    if (version.status !== 'draft') throw new VersionInvalidTransitionError();

    const publishedBy = (await this.resolveAdminUserId(actor)) ?? actor.userId;
    const affected = await this.scoped.update(
      RewardVersion,
      { status: 'published', publishedAt: new Date(), publishedBy },
      { where: { id: versionId, rewardId, status: 'draft' } },
    );
    if (affected === 0) throw new VersionInvalidTransitionError();

    const after = await this.findVersionOrFail(rewardId, versionId);
    this.audit.annotate({
      targetId: versionId,
      targetType: 'reward_version',
      detail: { event: 'published' },
    });
    return toRewardVersionWithValueDto(after, await this.suggestionFor(after));
  }

  async deprecate(
    actor: AuthenticatedUser,
    rewardId: number,
    versionId: number,
  ): Promise<RewardVersionWithValueDto> {
    assertRole(actor, 'super_admin');
    await this.findVersionOrFail(rewardId, versionId);

    const affected = await this.scoped.update(
      RewardVersion,
      { status: 'deprecated', deprecatedAt: new Date() },
      { where: { id: versionId, rewardId, status: 'published' } },
    );
    if (affected === 0) throw new VersionInvalidTransitionError();

    const after = await this.findVersionOrFail(rewardId, versionId);
    this.audit.annotate({
      targetId: versionId,
      targetType: 'reward_version',
      detail: { event: 'deprecated' },
    });
    return toRewardVersionWithValueDto(after, await this.suggestionFor(after));
  }

  async retire(
    actor: AuthenticatedUser,
    rewardId: number,
    versionId: number,
  ): Promise<RewardVersionWithValueDto> {
    assertRole(actor, 'super_admin');
    await this.findVersionOrFail(rewardId, versionId);

    const affected = await this.scoped.update(
      RewardVersion,
      { status: 'retired', retiredAt: new Date() },
      { where: { id: versionId, rewardId, status: 'deprecated' } },
    );
    if (affected === 0) throw new VersionInvalidTransitionError();

    const after = await this.findVersionOrFail(rewardId, versionId);
    this.audit.annotate({
      targetId: versionId,
      targetType: 'reward_version',
      detail: { event: 'retired' },
    });
    return toRewardVersionWithValueDto(after, await this.suggestionFor(after));
  }

  async withdrawFromCountry(
    actor: AuthenticatedUser,
    rewardId: number,
    versionId: number,
    countryId: number,
  ): Promise<void> {
    assertRole(actor, 'super_admin');
    await this.findVersionOrFail(rewardId, versionId);
    const assignment = await this.scoped.findOneOrFail(RewardVersionCountryAssignment, {
      where: { rewardVersionId: versionId, countryId },
    });

    const campaigns = await findActiveCampaignsUsingRewardVersionInCountry(
      this.sequelize,
      versionId,
      countryId,
    );
    if (campaigns.length > 0) throw new VersionHasCampaignsError(campaigns);

    await this.scoped.update(
      RewardVersionCountryAssignment,
      { status: 'withdrawn', effectiveTo: new Date() },
      { where: { id: assignment.id } },
    );
    this.audit.annotate({
      targetId: assignment.id,
      targetType: 'reward_version_assignment',
      detail: { rewardId, versionId, countryId },
    });
  }

  // --- private helpers -----------------------------------------------------------------------

  /**
   * T-119 — refuses a `value_config` that does not match its `reward_kind` (TC-2/TC-3/TC-4), and a
   * `value_config` supplied with no Kind at all. 400, with a `details` entry naming the offending
   * field, the same shape every other validation failure in this project reports.
   *
   * The judgment itself is `packages/shared`'s `rewardVersionValueSchema`, not a second copy of
   * the rules written here — that is the whole point of putting the union in the shared package
   * (00-ARCHITECTURE.md §8). Note what is deliberately *not* rejected: a Kind with no value config
   * yet. Choosing `PERCENTAGE` and filling the number in the next keystroke is a normal draft
   * state, and a draft is exactly where an incomplete configuration belongs.
   */
  private assertRewardValue(
    rewardKind: RewardKind | null | undefined,
    valueConfig: Record<string, unknown> | null | undefined,
  ): void {
    if (isRewardVersionValue(rewardKind, valueConfig)) return;
    const field =
      rewardKind === null || rewardKind === undefined ? 'rewardKind' : ('valueConfig' as const);
    throw new ValidationFailedError([{ field, code: 'INVALID_REWARD_VALUE_CONFIG' }], {
      logMessage: `reward_versions.value_config does not match reward_kind ${String(rewardKind)}`,
      logContext: { rewardKind },
    });
  }

  private async findRewardOrFail(rewardId: number): Promise<RewardSystem> {
    return this.scoped.findByPkOrFail(RewardSystem, rewardId, { where: { tenantId: null } });
  }

  private async findVersionOrFail(rewardId: number, versionId: number): Promise<RewardVersion> {
    return this.scoped.findByPkOrFail(RewardVersion, versionId, { where: { rewardId } });
  }

  private async latestPublishedVersion(rewardId: number): Promise<RewardVersion | null> {
    const rows = await this.scoped.listAll(RewardVersion, {
      where: { rewardId, status: 'published' },
      order: [['versionNo', 'DESC']],
      limit: 1,
    });
    return rows[0] ?? null;
  }

  private async nextVersionNo(rewardId: number): Promise<number> {
    const rows = await this.scoped.listAll(RewardVersion, {
      where: { rewardId },
      order: [['versionNo', 'DESC']],
      limit: 1,
    });
    return (rows[0]?.versionNo ?? 0) + 1;
  }

  private async loadSupersedes(version: RewardVersion): Promise<RewardVersion | null> {
    if (version.supersedesVersionId === null) return null;
    return this.scoped
      .findOneOrFail(RewardVersion, { where: { id: version.supersedesVersionId } })
      .catch(() => null);
  }

  private async suggestionFor(version: RewardVersion): Promise<boolean | null> {
    const supersedes = await this.loadSupersedes(version);
    if (supersedes === null) return null;
    return suggestIsBreaking(
      diffFlatObjectKeys(supersedes.connectorConfig, version.connectorConfig),
    );
  }

  private computeSuggestion(
    version: RewardVersion,
    byId: Map<number, RewardVersion>,
  ): boolean | null {
    if (version.supersedesVersionId === null) return null;
    const supersedes = byId.get(version.supersedesVersionId);
    if (supersedes === undefined) return null;
    return suggestIsBreaking(
      diffFlatObjectKeys(supersedes.connectorConfig, version.connectorConfig),
    );
  }

  /** Mirrors `RuleVersionsService#resolveAdminUserId`. */
  private async resolveAdminUserId(actor: AuthenticatedUser): Promise<number | null> {
    const self = await this.scoped.findByPkOrFail(PortalUser, actor.userId);
    return self.adminUserId;
  }
}

function fieldSnapshot(version: RewardVersion): Record<string, unknown> {
  return {
    connectorConfig: version.connectorConfig,
    deliveryMode: version.deliveryMode,
    retryConfig: version.retryConfig,
    policiesSnapshot: version.policiesSnapshot,
    unitType: version.unitType,
    unitCode: version.unitCode,
    // T-119 — a Kind/value change on a draft is audited like every other payload change.
    rewardKind: version.rewardKind,
    valueConfig: version.valueConfig,
    changeSummary: version.changeSummary,
    isBreaking: version.isBreaking,
  };
}
