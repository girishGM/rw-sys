/**
 * T-041 — `/rules/:id/versions`: the version lifecycle over `rule_master` (06-VERSIONING.md
 * §4/§9). Publishing and blasting are two separate acts (implementation note 1) — this service
 * owns the former (draft → published → deprecated → retired) and country-assignment views;
 * `BlastsService` (`modules/blasts/**`) owns the blast itself.
 *
 * ### The three layers, same as `RulesService` (T-031)
 *
 * 1. **Permission** — reads reuse `RULE_ENTITY:view` (`versions.constants.ts`'s own header
 *    explains why there is no dedicated `version` entity); writes carry `@Roles('super_admin')`
 *    at the controller.
 * 2. **`assertRole(actor, 'super_admin')`** at the top of every mutating method here,
 *    independent of the controller's `@Roles` — `assert-role.ts`'s own instruction names this
 *    task explicitly.
 * 3. **Data** — every write is scoped to `ruleId` (never a bare `versionId`, so a version id
 *    cannot be reused across an unrelated rule) and routes through `ScopedRepository`, whose
 *    `RuleVersion` scope-strategy entry (`scope-strategy.ts`, T-013) makes a non-super-admin
 *    actor's *write* path structurally unreachable regardless of what the guards do — the same
 *    property `RulesService`'s own header documents for `RuleMaster`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { UniqueConstraintError } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { Country, RuleMaster, RuleVersion, RuleVersionCountryAssignment } from '@/database/models';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { PortalUser } from '@/database/portal-models';
import { assertRole } from '@/common/rbac/assert-role';
import { AuditService } from '@/common/audit/audit.service';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { diffRuleParameterFields, suggestIsBreaking } from './version-diff.util';
import { findActiveCampaignsUsingRuleVersionInCountry } from './version-campaign-usage.query';
import type { CreateVersionDto } from './dto/create-version.dto';
import type { UpdateRuleVersionDto } from './dto/update-rule-version.dto';
import {
  toRuleVersionDto,
  toRuleVersionCountryAssignmentDto,
  toVersionDiffDto,
  type RuleVersionDto,
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
export class RuleVersionsService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly audit: AuditService,
  ) {}

  // --- reads -----------------------------------------------------------------------------

  /** `GET /rules/:id/versions` — newest first. Visibility is `RuleVersion`'s own scope-strategy
   * entry: "a version follows its rule's visibility" (`scope-strategy.ts`). */
  async list(ruleId: number): Promise<readonly RuleVersionDto[]> {
    await this.findRuleOrFail(ruleId);
    const versions = await this.scoped.listAll(RuleVersion, {
      where: { ruleId },
      order: [['versionNo', 'DESC']],
    });
    const byId = new Map(versions.map((version) => [version.id, version]));
    return versions.map((version) =>
      toRuleVersionDto(version, this.computeSuggestion(version, byId)),
    );
  }

  /** `GET /rules/:id/versions/:vid`. */
  async getById(ruleId: number, versionId: number): Promise<RuleVersionDto> {
    const version = await this.findVersionOrFail(ruleId, versionId);
    const suggestion = await this.suggestionFor(version);
    return toRuleVersionDto(version, suggestion);
  }

  /** `GET /rules/:id/versions/:vid/diff/:otherVid` (implementation note 8). */
  async diff(ruleId: number, versionId: number, otherVersionId: number): Promise<VersionDiffDto> {
    const version = await this.findVersionOrFail(ruleId, versionId);
    const other = await this.findVersionOrFail(ruleId, otherVersionId);
    const fieldDiff = diffRuleParameterFields(version.parameters, other.parameters);

    return toVersionDiffDto({
      versionId: version.id,
      otherVersionId: other.id,
      versionNo: version.versionNo,
      otherVersionNo: other.versionNo,
      expressionChanged: version.expression !== other.expression,
      diff: fieldDiff,
      suggestedIsBreaking: suggestIsBreaking(fieldDiff),
    });
  }

  /** `GET /rules/:id/versions/:vid/countries`. */
  async listCountryAssignments(
    ruleId: number,
    versionId: number,
  ): Promise<readonly VersionCountryAssignmentDto[]> {
    await this.findVersionOrFail(ruleId, versionId);
    const rows = await this.scoped.listAll(RuleVersionCountryAssignment, {
      where: { ruleVersionId: versionId },
      include: [Country, RuleVersion],
      order: [['assignedAt', 'ASC']],
    });
    return rows.map((row) =>
      toRuleVersionCountryAssignmentDto(
        row as RuleVersionCountryAssignment & { country: Country; ruleVersion: RuleVersion },
      ),
    );
  }

  // --- writes ------------------------------------------------------------------------------

  /** `POST /rules/:id/versions` (implementation note 2, TC-1/TC-2). */
  async createDraft(
    actor: AuthenticatedUser,
    ruleId: number,
    dto: CreateVersionDto,
  ): Promise<RuleVersionDto> {
    assertRole(actor, 'super_admin');
    const rule = await this.findRuleOrFail(ruleId);

    const existingDraftCount = await this.scoped.count(RuleVersion, {
      where: { ruleId, status: 'draft' },
    });
    if (existingDraftCount > 0) throw new VersionDraftAlreadyExistsError();

    const latestPublished = await this.latestPublishedVersion(ruleId);
    const nextVersionNo = await this.nextVersionNo(ruleId);
    const createdBy = await this.resolveAdminUserId(actor);

    const basePayload =
      latestPublished === null
        ? { expression: rule.expression, parameters: rule.parameters }
        : { expression: latestPublished.expression, parameters: latestPublished.parameters };

    let created: RuleVersion;
    try {
      created = await this.scoped.create(RuleVersion, {
        ruleId,
        versionNo: nextVersionNo,
        expression: basePayload.expression,
        parameters: basePayload.parameters,
        changeSummary: dto.changeSummary ?? null,
        isBreaking: false,
        status: 'draft',
        supersedesVersionId: latestPublished?.id ?? null,
        originRequestId: dto.originRequestId ?? null,
        // `rule_versions.created_by` is `NOT NULL` but — unlike `rule_master.created_by` —
        // carries **no** `admin_users` FK in the live DDL (T005_001), so there is no
        // constraint to violate either way; the actor's own portal id is a real, meaningful
        // fallback here, not a sentinel, when no `admin_user_id` bridge exists
        // (`resolveAdminUserId`'s own comment has the full bridge reasoning).
        createdBy: createdBy ?? actor.userId,
      } as never);
    } catch (error) {
      // `uq_rv_one_draft` is the backstop for a concurrent second draft — the same TOCTOU
      // narrowing `RulesService.create`'s own header documents for `ruleCode`.
      if (error instanceof UniqueConstraintError)
        throw new VersionDraftAlreadyExistsError({ cause: error });
      throw error;
    }

    this.audit.annotate({
      targetId: created.id,
      targetType: 'rule_version',
      detail: { ruleId, versionNo: created.versionNo },
    });
    return toRuleVersionDto(created, latestPublished === null ? null : false);
  }

  /** `PATCH /rules/:id/versions/:vid` — draft only (TC-3/TC-4). */
  async updateDraft(
    actor: AuthenticatedUser,
    ruleId: number,
    versionId: number,
    dto: UpdateRuleVersionDto,
  ): Promise<RuleVersionDto> {
    assertRole(actor, 'super_admin');
    const before = await this.findVersionOrFail(ruleId, versionId);
    if (before.status !== 'draft') throw new VersionInvalidTransitionError();

    const changes: Record<string, unknown> = {};
    if (dto.expression !== undefined) changes['expression'] = dto.expression;
    if (dto.parameters !== undefined) changes['parameters'] = dto.parameters;
    if (dto.changeSummary !== undefined) changes['changeSummary'] = dto.changeSummary;

    if (dto.isBreaking !== undefined) {
      const nextParameters = dto.parameters ?? before.parameters;
      const supersedes = await this.loadSupersedes(before);
      const fieldDiff = diffRuleParameterFields(supersedes?.parameters ?? null, nextParameters);
      const suggested = suggestIsBreaking(fieldDiff);
      if (dto.isBreaking !== suggested && dto.confirmBreakingOverride !== true) {
        throw new VersionBreakingConfirmationRequiredError(suggested);
      }
      changes['isBreaking'] = dto.isBreaking;
    }

    if (Object.keys(changes).length > 0) {
      const affected = await this.scoped.update(RuleVersion, changes, {
        where: { id: versionId, ruleId, status: 'draft' },
      });
      if (affected === 0) throw new VersionInvalidTransitionError();
    }

    const after = await this.findVersionOrFail(ruleId, versionId);
    this.audit.annotate({
      targetId: versionId,
      targetType: 'rule_version',
      detail: {
        changes: this.audit.diffFields(fieldSnapshot(before), fieldSnapshot(after)),
      },
    });
    return toRuleVersionDto(after, await this.suggestionFor(after));
  }

  /** `POST /rules/:id/versions/:vid/publish` (TC-5/TC-6). */
  async publish(
    actor: AuthenticatedUser,
    ruleId: number,
    versionId: number,
  ): Promise<RuleVersionDto> {
    assertRole(actor, 'super_admin');
    const version = await this.findVersionOrFail(ruleId, versionId);
    if (version.status !== 'draft') throw new VersionInvalidTransitionError();

    // `ck_rv_published_fields` requires `published_by` non-null once `status <> 'draft'` —
    // same fallback reasoning as `createDraft`'s `createdBy`.
    const publishedBy = (await this.resolveAdminUserId(actor)) ?? actor.userId;
    const affected = await this.scoped.update(
      RuleVersion,
      { status: 'published', publishedAt: new Date(), publishedBy },
      { where: { id: versionId, ruleId, status: 'draft' } },
    );
    if (affected === 0) throw new VersionInvalidTransitionError();

    const after = await this.findVersionOrFail(ruleId, versionId);
    this.audit.annotate({
      targetId: versionId,
      targetType: 'rule_version',
      detail: { event: 'published' },
    });
    return toRuleVersionDto(after, await this.suggestionFor(after));
  }

  /** `POST /rules/:id/versions/:vid/deprecate` — `published` → `deprecated` only. */
  async deprecate(
    actor: AuthenticatedUser,
    ruleId: number,
    versionId: number,
  ): Promise<RuleVersionDto> {
    assertRole(actor, 'super_admin');
    await this.findVersionOrFail(ruleId, versionId);

    const affected = await this.scoped.update(
      RuleVersion,
      { status: 'deprecated', deprecatedAt: new Date() },
      { where: { id: versionId, ruleId, status: 'published' } },
    );
    if (affected === 0) throw new VersionInvalidTransitionError();

    const after = await this.findVersionOrFail(ruleId, versionId);
    this.audit.annotate({
      targetId: versionId,
      targetType: 'rule_version',
      detail: { event: 'deprecated' },
    });
    return toRuleVersionDto(after, await this.suggestionFor(after));
  }

  /** `POST /rules/:id/versions/:vid/retire` — `deprecated` → `retired` only (06-VERSIONING.md
   * §4.3's fixed lifecycle order). The version keeps resolving for historical gRPC lookups
   * (TC-24) — retiring never deletes the row. */
  async retire(
    actor: AuthenticatedUser,
    ruleId: number,
    versionId: number,
  ): Promise<RuleVersionDto> {
    assertRole(actor, 'super_admin');
    await this.findVersionOrFail(ruleId, versionId);

    const affected = await this.scoped.update(
      RuleVersion,
      { status: 'retired', retiredAt: new Date() },
      { where: { id: versionId, ruleId, status: 'deprecated' } },
    );
    if (affected === 0) throw new VersionInvalidTransitionError();

    const after = await this.findVersionOrFail(ruleId, versionId);
    this.audit.annotate({
      targetId: versionId,
      targetType: 'rule_version',
      detail: { event: 'retired' },
    });
    return toRuleVersionDto(after, await this.suggestionFor(after));
  }

  /** `DELETE /rules/:id/versions/:vid/countries/:countryId` — withdraw (TC-21/TC-22). */
  async withdrawFromCountry(
    actor: AuthenticatedUser,
    ruleId: number,
    versionId: number,
    countryId: number,
  ): Promise<void> {
    assertRole(actor, 'super_admin');
    await this.findVersionOrFail(ruleId, versionId);
    const assignment = await this.scoped.findOneOrFail(RuleVersionCountryAssignment, {
      where: { ruleVersionId: versionId, countryId },
    });

    const campaigns = await findActiveCampaignsUsingRuleVersionInCountry(
      this.sequelize,
      versionId,
      countryId,
    );
    if (campaigns.length > 0) throw new VersionHasCampaignsError(campaigns);

    await this.scoped.update(
      RuleVersionCountryAssignment,
      { status: 'withdrawn', effectiveTo: new Date() },
      { where: { id: assignment.id } },
    );
    this.audit.annotate({
      targetId: assignment.id,
      targetType: 'rule_version_assignment',
      detail: { ruleId, versionId, countryId },
    });
  }

  // --- private helpers -----------------------------------------------------------------------

  private async findRuleOrFail(ruleId: number): Promise<RuleMaster> {
    return this.scoped.findByPkOrFail(RuleMaster, ruleId, { where: { tenantId: null } });
  }

  private async findVersionOrFail(ruleId: number, versionId: number): Promise<RuleVersion> {
    return this.scoped.findByPkOrFail(RuleVersion, versionId, { where: { ruleId } });
  }

  private async latestPublishedVersion(ruleId: number): Promise<RuleVersion | null> {
    const rows = await this.scoped.listAll(RuleVersion, {
      where: { ruleId, status: 'published' },
      order: [['versionNo', 'DESC']],
      limit: 1,
    });
    return rows[0] ?? null;
  }

  private async nextVersionNo(ruleId: number): Promise<number> {
    const rows = await this.scoped.listAll(RuleVersion, {
      where: { ruleId },
      order: [['versionNo', 'DESC']],
      limit: 1,
    });
    return (rows[0]?.versionNo ?? 0) + 1;
  }

  private async loadSupersedes(version: RuleVersion): Promise<RuleVersion | null> {
    if (version.supersedesVersionId === null) return null;
    return this.scoped
      .findOneOrFail(RuleVersion, { where: { id: version.supersedesVersionId } })
      .catch(() => null);
  }

  private async suggestionFor(version: RuleVersion): Promise<boolean | null> {
    const supersedes = await this.loadSupersedes(version);
    if (supersedes === null) return null;
    return suggestIsBreaking(diffRuleParameterFields(supersedes.parameters, version.parameters));
  }

  /** {@link suggestionFor}, batched — used by {@link list} so an N-version rule does not issue N
   * extra reads when the previous version is already in the page just loaded. */
  private computeSuggestion(version: RuleVersion, byId: Map<number, RuleVersion>): boolean | null {
    if (version.supersedesVersionId === null) return null;
    const supersedes = byId.get(version.supersedesVersionId);
    if (supersedes === undefined) return null;
    return suggestIsBreaking(diffRuleParameterFields(supersedes.parameters, version.parameters));
  }

  /** Mirrors `RulesService#resolveAdminUserId` (T-031) exactly — see that method's own comment
   * for the full `portal_users.admin_user_id` bridge reasoning. Duplicated rather than shared
   * across modules, the same choice `rules/campaign-usage.query.ts` vs `rewards/campaign-usage.query.ts`
   * already makes for a near-identical helper. */
  private async resolveAdminUserId(actor: AuthenticatedUser): Promise<number | null> {
    const self = await this.scoped.findByPkOrFail(PortalUser, actor.userId);
    return self.adminUserId;
  }
}

/** The plain-object snapshot `AuditService.diffFields` compares. */
function fieldSnapshot(version: RuleVersion): Record<string, unknown> {
  return {
    expression: version.expression,
    parameters: version.parameters,
    changeSummary: version.changeSummary,
    isBreaking: version.isBreaking,
  };
}
