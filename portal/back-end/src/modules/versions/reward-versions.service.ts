/**
 * T-041 — `/rewards/:id/versions`: the reward-side mirror of `RuleVersionsService`, over
 * `reward_systems`/`reward_versions` (06-VERSIONING.md §5.1/§9 — "Reward equivalents mirror
 * these exactly"). See that file's own header for the three-layer authority story and the
 * `assertRole`/scope reasoning, identical here.
 *
 * `connectorConfig` is diffed by top-level key (`diffFlatObjectKeys`), the documented stand-in
 * for a rule's `parameters.fields` — `version-diff.util.ts`'s own header explains the mapping.
 */
import { Inject, Injectable } from '@nestjs/common';
import { UniqueConstraintError } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
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
import type { CreateVersionDto } from './dto/create-version.dto';
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

@Injectable()
export class RewardVersionsService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly audit: AuditService,
  ) {}

  // --- reads -----------------------------------------------------------------------------

  async list(rewardId: number): Promise<readonly RewardVersionDto[]> {
    await this.findRewardOrFail(rewardId);
    const versions = await this.scoped.listAll(RewardVersion, {
      where: { rewardId },
      order: [['versionNo', 'DESC']],
    });
    const byId = new Map(versions.map((version) => [version.id, version]));
    return versions.map((version) =>
      toRewardVersionDto(version, this.computeSuggestion(version, byId)),
    );
  }

  async getById(rewardId: number, versionId: number): Promise<RewardVersionDto> {
    const version = await this.findVersionOrFail(rewardId, versionId);
    return toRewardVersionDto(version, await this.suggestionFor(version));
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
    dto: CreateVersionDto,
  ): Promise<RewardVersionDto> {
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
          }
        : {
            connectorConfig: latestPublished.connectorConfig,
            deliveryMode: latestPublished.deliveryMode,
            retryConfig: latestPublished.retryConfig,
            policiesSnapshot: latestPublished.policiesSnapshot,
            unitType: latestPublished.unitType,
            unitCode: latestPublished.unitCode,
          };

    let created: RewardVersion;
    try {
      created = await this.scoped.create(RewardVersion, {
        rewardId,
        versionNo: nextVersionNo,
        ...basePayload,
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
      detail: { rewardId, versionNo: created.versionNo },
    });
    return toRewardVersionDto(created, latestPublished === null ? null : false);
  }

  async updateDraft(
    actor: AuthenticatedUser,
    rewardId: number,
    versionId: number,
    dto: UpdateRewardVersionDto,
  ): Promise<RewardVersionDto> {
    assertRole(actor, 'super_admin');
    const before = await this.findVersionOrFail(rewardId, versionId);
    if (before.status !== 'draft') throw new VersionInvalidTransitionError();

    const changes: Record<string, unknown> = {};
    if (dto.connectorConfig !== undefined) changes['connectorConfig'] = dto.connectorConfig;
    if (dto.deliveryMode !== undefined) changes['deliveryMode'] = dto.deliveryMode;
    if (dto.retryConfig !== undefined) changes['retryConfig'] = dto.retryConfig;
    if (dto.policiesSnapshot !== undefined) changes['policiesSnapshot'] = dto.policiesSnapshot;
    if (dto.unitType !== undefined) changes['unitType'] = dto.unitType;
    if (dto.unitCode !== undefined) changes['unitCode'] = dto.unitCode;
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
    return toRewardVersionDto(after, await this.suggestionFor(after));
  }

  async publish(
    actor: AuthenticatedUser,
    rewardId: number,
    versionId: number,
  ): Promise<RewardVersionDto> {
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
    return toRewardVersionDto(after, await this.suggestionFor(after));
  }

  async deprecate(
    actor: AuthenticatedUser,
    rewardId: number,
    versionId: number,
  ): Promise<RewardVersionDto> {
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
    return toRewardVersionDto(after, await this.suggestionFor(after));
  }

  async retire(
    actor: AuthenticatedUser,
    rewardId: number,
    versionId: number,
  ): Promise<RewardVersionDto> {
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
    return toRewardVersionDto(after, await this.suggestionFor(after));
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
    changeSummary: version.changeSummary,
    isBreaking: version.isBreaking,
  };
}
