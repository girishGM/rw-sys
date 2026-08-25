/**
 * T-041 — `POST /blasts`, `POST /blasts/preview`, `GET /blasts`, `GET /blasts/:id`
 * (06-VERSIONING.md §6). The blast is one transaction: `version_blasts` →
 * `version_blast_targets` → `*_version_country_assignments` → the legacy
 * `rule_country_assignments`/`reward_country_assignments` upsert → prior assignments marked
 * `superseded` → notify → audit (implementation note 4). Notification is the one step that
 * runs **after** commit, not inside the transaction — `NotificationsService.notify()` never
 * rejects and writes through its own connection outside any transaction the caller opens
 * (`notifications.repository.ts`'s own `insert()` takes no `transaction` option at all), so
 * running it before commit would either notify about a blast that then rolls back, or simply
 * not participate in the atomicity the transaction exists to guarantee either way.
 *
 * ### Why `VersionBlast` itself is read two different ways for `list`/`getById`
 *
 * `scope-strategy.ts`'s own `VersionBlast` entry denies `country`/`tenant` scope outright
 * ("nobody below sees the blast row") and gives `VersionBlastTarget` a `country` rule instead
 * ("a country may see the blast rows targeting it — that is its own delivery status"). That is
 * this task's read path, not a limitation to work around: a `super_admin` reads `VersionBlast`
 * directly; a `country_admin` reads their own, already-scoped `VersionBlastTarget` rows with
 * `VersionBlast` eager-loaded through the association — a single joined query, not a second
 * scope check — the same "include for display, never re-scoped" pattern
 * `RulesService.listCountryAssignments` already uses for `include: [Country]`.
 *
 * ### The three layers, same shape as every other Wave 3 write
 *
 * 1. **Permission** — `@Roles('super_admin')` (`POST /blasts`, `POST /blasts/preview`) or
 *    `@Roles('super_admin', 'country_admin')` (`GET /blasts`, `GET /blasts/:id`) at the
 *    controller — `blasts.constants.ts`'s header explains why there is no dedicated
 *    `role_entity_permissions` entity for this route set.
 * 2. **`assertRole`** at the top of every method here, independent of the controller — the one
 *    `assert-role.ts` names this task for by number: *"T-033's `access_control` writes and
 *    T-041's blast operations should too."*
 * 3. **Data** — `RuleVersionCountryAssignment`/`RewardVersionCountryAssignment`'s own
 *    scope-strategy entries make a non-super-admin actor's write path structurally
 *    unreachable regardless of the guards, the same property every other Wave 3 service's
 *    header documents.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Op,
  UniqueConstraintError,
  type Model,
  type ModelStatic,
  type Transaction,
} from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import {
  Country,
  RewardCountryAssignment,
  RewardSystem,
  RewardVersion,
  RewardVersionCountryAssignment,
  RuleCountryAssignment,
  RuleMaster,
  RuleVersion,
  RuleVersionCountryAssignment,
  Tenant,
  VersionBlast,
  VersionBlastTarget,
} from '@/database/models';
import { PortalUser } from '@/database/portal-models';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { assertRole } from '@/common/rbac/assert-role';
import { AuditService } from '@/common/audit/audit.service';
import {
  NotificationsService,
  type NotifyInput,
} from '@/modules/notifications/notifications.service';
import type { NotificationType } from '@/modules/notifications/notifications.constants';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import {
  findActiveCampaignsUsingRewardVersionInCountry,
  findActiveCampaignsUsingRuleVersionInCountry,
} from '@/modules/versions/version-campaign-usage.query';
import { ACTIVE_COUNTRY_STATUS, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './blasts.constants';
import {
  BreakingConfirmationRequiredError,
  InvalidCountrySelectionError,
  VersionNotPublishedError,
} from './blasts.errors';
import type { CreateBlastDto } from './dto/create-blast.dto';
import type { PreviewBlastDto } from './dto/preview-blast.dto';
import type { ListBlastsQueryDto } from './dto/list-blasts-query.dto';
import {
  toBlastDto,
  type BlastDto,
  type BlastPreviewCountryImpactDto,
  type BlastPreviewDto,
  type ListMeta,
} from './dto/blast-response.dto';

interface ResolvedVersion {
  readonly versionNo: number;
  readonly status: string;
  readonly isBreaking: boolean;
}

interface CurrentAssignment {
  readonly versionId: number;
  readonly versionNo: number;
}

/** Named rather than inlined at each cast site — the inline union form prettier would produce
 * for these two blows past `printWidth` at every indent level this file uses them from. */
type RuleAssignmentWithVersion = RuleVersionCountryAssignment & { ruleVersion: RuleVersion };
type RewardAssignmentWithVersion = RewardVersionCountryAssignment & {
  rewardVersion: RewardVersion;
};

@Injectable()
export class BlastsService {
  private readonly logger = new Logger(BlastsService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // --- preview (implementation note 6, TC-19/TC-20) -----------------------------------------

  async preview(actor: AuthenticatedUser, dto: PreviewBlastDto): Promise<BlastPreviewDto> {
    assertRole(actor, 'super_admin');
    const version = await this.resolveVersion(dto.entityType, dto.entityId, dto.versionId);
    if (version.status !== 'published') throw new VersionNotPublishedError();

    const countries = await this.resolveCountries(dto.scope, dto.countryIds);
    const impacts: BlastPreviewCountryImpactDto[] = [];
    for (const country of countries) {
      const current = await this.currentAssignment(dto.entityType, dto.entityId, country.id);
      const campaignCount =
        current === null
          ? 0
          : await this.activeCampaignCount(dto.entityType, current.versionId, country.id);
      impacts.push({
        countryId: country.id,
        countryCode: country.code,
        countryName: country.name,
        currentVersionNo: current?.versionNo ?? null,
        willReceiveVersionNo: version.versionNo,
        activeCampaignsOnCurrentVersion: campaignCount,
        isBreaking: version.isBreaking,
      });
    }

    return {
      entityType: dto.entityType,
      entityId: dto.entityId,
      versionId: dto.versionId,
      versionNo: version.versionNo,
      isBreaking: version.isBreaking,
      countries: impacts,
    };
  }

  // --- the blast (implementation note 4, TC-7…TC-15) ----------------------------------------

  async create(actor: AuthenticatedUser, dto: CreateBlastDto): Promise<BlastDto> {
    assertRole(actor, 'super_admin');
    const version = await this.resolveVersion(dto.entityType, dto.entityId, dto.versionId);
    if (version.status !== 'published') throw new VersionNotPublishedError();
    if (version.isBreaking && dto.confirmBreaking !== true) {
      throw new BreakingConfirmationRequiredError();
    }

    const countries = await this.resolveCountries(dto.scope, dto.countryIds);
    // Two different fallbacks for two differently-shaped columns — see `applyRuleAssignment`'s
    // own comment for the full reasoning: `version_blasts.blasted_by` and
    // `*_version_country_assignments.assigned_by` are `NOT NULL` with **no** `admin_users` FK
    // (safe to fall back to the actor's own portal id), but the *legacy*
    // `rule_country_assignments`/`reward_country_assignments.assigned_by` carries a real
    // `fk_rca_admin`/`fk_rwca_admin` — the same column `RulesService#resolveAdminUserId`'s own
    // comment documents — so it must stay `null` rather than receive a portal id that fails
    // that FK.
    const adminUserId = await this.resolveAdminUserId(actor);
    const blastedBy = adminUserId ?? actor.userId;

    const blastId = await this.sequelize.transaction(async (transaction) => {
      const blast = await this.scoped.create(
        VersionBlast,
        {
          entityType: dto.entityType,
          entityId: dto.entityId,
          versionId: dto.versionId,
          versionNo: version.versionNo,
          scope: dto.scope,
          targetCount: countries.length,
          note: dto.note ?? null,
          originRequestId: dto.originRequestId ?? null,
          blastedBy,
        } as never,
        { transaction },
      );

      for (const country of countries) {
        await this.scoped.create(
          VersionBlastTarget,
          { blastId: blast.id, countryId: country.id, status: 'delivered' } as never,
          { transaction },
        );

        if (dto.entityType === 'rule') {
          await this.applyRuleAssignment(
            dto.entityId,
            dto.versionId,
            country.id,
            blast.id,
            blastedBy,
            adminUserId,
            transaction,
          );
        } else {
          await this.applyRewardAssignment(
            dto.entityId,
            dto.versionId,
            country.id,
            blast.id,
            blastedBy,
            adminUserId,
            transaction,
          );
        }
      }

      return blast.id;
    });

    this.audit.annotate({
      targetId: blastId,
      targetType: 'version_blast',
      detail: {
        entityType: dto.entityType,
        entityId: dto.entityId,
        versionId: dto.versionId,
        versionNo: version.versionNo,
        scope: dto.scope,
        countryIds: countries.map((country) => country.id),
      },
    });

    // Best-effort, after commit — see the file header for why this can never run inside the
    // transaction above. Never allowed to fail the response (TC-27's 3s budget included).
    await this.notifyCountryAdmins(dto.entityType, dto.entityId, version.versionNo, countries);

    return this.getById(actor, blastId);
  }

  // --- reads (TC-16…TC-18) --------------------------------------------------------------------

  async list(
    actor: AuthenticatedUser,
    query: ListBlastsQueryDto,
  ): Promise<{ rows: BlastDto[]; meta: ListMeta }> {
    assertRole(actor, 'super_admin', 'country_admin');
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    if (actor.role === 'super_admin') {
      const where: Record<string, unknown> = {};
      if (query.entityType !== undefined) where['entityType'] = query.entityType;
      if (query.entityId !== undefined) where['entityId'] = query.entityId;

      const rows = await this.scoped.listAll(VersionBlast, {
        where,
        order: [['blastedAt', 'DESC']],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      const total = await this.scoped.count(VersionBlast, { where });
      const dtos = await Promise.all(rows.map((row) => this.toFullBlastDto(row)));
      return { rows: dtos, meta: { page, pageSize, total } };
    }

    // `country_admin` — see the file header for why this reads `VersionBlastTarget`, scoped to
    // their own country, rather than `VersionBlast` (denied outright for this role).
    const targetRows = await this.scoped.listAll(VersionBlastTarget, {
      include: [{ model: VersionBlast }, Country],
      order: [['id', 'DESC']],
    });
    let rows = targetRows as (VersionBlastTarget & { blast: VersionBlast; country: Country })[];
    if (query.entityType !== undefined) {
      rows = rows.filter((row) => row.blast.entityType === query.entityType);
    }
    if (query.entityId !== undefined) {
      rows = rows.filter((row) => row.blast.entityId === query.entityId);
    }

    const total = rows.length;
    const page1 = rows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
    const dtos = page1.map((row) => toBlastDto(row.blast, [row]));
    return { rows: dtos, meta: { page, pageSize, total } };
  }

  async getById(actor: AuthenticatedUser, id: number): Promise<BlastDto> {
    assertRole(actor, 'super_admin', 'country_admin');

    if (actor.role === 'super_admin') {
      const blast = await this.scoped.findByPkOrFail(VersionBlast, id);
      return this.toFullBlastDto(blast);
    }

    const target = await this.scoped.findOneOrFail(VersionBlastTarget, {
      where: { blastId: id },
      include: [{ model: VersionBlast }, Country],
    });
    const row = target as VersionBlastTarget & { blast: VersionBlast; country: Country };
    return toBlastDto(row.blast, [row]);
  }

  // --- private: version/country resolution ----------------------------------------------------

  private async resolveVersion(
    entityType: 'rule' | 'reward',
    entityId: number,
    versionId: number,
  ): Promise<ResolvedVersion> {
    if (entityType === 'rule') {
      await this.scoped.findByPkOrFail(RuleMaster, entityId, { where: { tenantId: null } });
      const version = await this.scoped.findByPkOrFail(RuleVersion, versionId, {
        where: { ruleId: entityId },
      });
      return {
        versionNo: version.versionNo,
        status: version.status,
        isBreaking: version.isBreaking,
      };
    }

    await this.scoped.findByPkOrFail(RewardSystem, entityId, { where: { tenantId: null } });
    const version = await this.scoped.findByPkOrFail(RewardVersion, versionId, {
      where: { rewardId: entityId },
    });
    return {
      versionNo: version.versionNo,
      status: version.status,
      isBreaking: version.isBreaking,
    };
  }

  private async resolveCountries(
    scope: 'all_countries' | 'selected',
    countryIds: readonly number[] | undefined,
  ): Promise<Country[]> {
    if (scope === 'all_countries') {
      const rows = await this.scoped.listAll(Country, {
        where: { status: ACTIVE_COUNTRY_STATUS },
        order: [['id', 'ASC']],
      });
      if (rows.length === 0) throw new InvalidCountrySelectionError();
      return rows;
    }

    const ids = [...new Set(countryIds ?? [])];
    if (ids.length === 0) throw new InvalidCountrySelectionError();

    const rows = await this.scoped.listAll(Country, { where: { id: ids } });
    if (rows.length !== ids.length) throw new InvalidCountrySelectionError();
    return rows;
  }

  private async currentAssignment(
    entityType: 'rule' | 'reward',
    entityId: number,
    countryId: number,
  ): Promise<CurrentAssignment | null> {
    if (entityType === 'rule') {
      const rows = await this.scoped.listAll(RuleVersionCountryAssignment, {
        where: { ruleId: entityId, countryId, status: 'active' },
        include: [RuleVersion],
        limit: 1,
      });
      const row = rows[0] as RuleAssignmentWithVersion | undefined;
      return row === undefined
        ? null
        : { versionId: row.ruleVersionId, versionNo: row.ruleVersion.versionNo };
    }

    const rows = await this.scoped.listAll(RewardVersionCountryAssignment, {
      where: { rewardId: entityId, countryId, status: 'active' },
      include: [RewardVersion],
      limit: 1,
    });
    const row = rows[0] as RewardAssignmentWithVersion | undefined;
    return row === undefined
      ? null
      : { versionId: row.rewardVersionId, versionNo: row.rewardVersion.versionNo };
  }

  private async activeCampaignCount(
    entityType: 'rule' | 'reward',
    versionId: number,
    countryId: number,
  ): Promise<number> {
    const campaigns =
      entityType === 'rule'
        ? await findActiveCampaignsUsingRuleVersionInCountry(this.sequelize, versionId, countryId)
        : await findActiveCampaignsUsingRewardVersionInCountry(
            this.sequelize,
            versionId,
            countryId,
          );
    return campaigns.length;
  }

  // --- private: the per-country write (implementation note 4) --------------------------------

  /**
   * `assignedBy` and `legacyAssignedBy` are deliberately two different values, not one reused
   * twice: `rule_version_country_assignments.assigned_by` is `NOT NULL` with **no**
   * `admin_users` FK (T005_003's own DDL), so the actor's own portal id is a safe, meaningful
   * fallback when no `admin_user_id` bridge exists (`resolveAdminUserId`'s own comment has the
   * full bridge reasoning) — that is `assignedBy`. The *legacy* `rule_country_assignments`
   * table predates this task and carries a real `fk_rca_admin → reward_config.admin_users(id)`
   * (confirmed live, the same constraint `RulesService#resolveAdminUserId`'s own comment
   * documents for this exact column), so writing a portal id there when no bridge exists would
   * violate that FK rather than merely be semantically approximate — `legacyAssignedBy` is the
   * raw, nullable bridge lookup, written through unchanged, exactly as
   * `RulesService.assignToCountry` already does for the same column.
   */
  private async applyRuleAssignment(
    ruleId: number,
    versionId: number,
    countryId: number,
    blastId: number,
    assignedBy: number,
    legacyAssignedBy: number | null,
    transaction: Transaction,
  ): Promise<void> {
    // Prior versions of this rule in this country → superseded, never removed (§6, TC-10).
    await this.scoped.update(
      RuleVersionCountryAssignment,
      { status: 'superseded', effectiveTo: new Date() },
      {
        where: { ruleId, countryId, status: 'active', ruleVersionId: { [Op.ne]: versionId } },
        transaction,
      },
    );

    await this.upsertAssignment(
      RuleVersionCountryAssignment,
      { ruleVersionId: versionId, countryId },
      { ruleVersionId: versionId, ruleId, countryId, blastId, status: 'active', assignedBy },
      {
        status: 'active',
        effectiveFrom: new Date(),
        effectiveTo: null,
        blastId,
        assignedBy,
        assignedAt: new Date(),
      },
      transaction,
    );

    // The legacy dual-write (06-VERSIONING.md §5.2) — deliberate, and must not be "cleaned up"
    // by a later agent: existing downstream consumers of `rule_country_assignments` keep
    // getting the right "is this rule available here at all?" answer with no change on their
    // side. `assignedBy: legacyAssignedBy` — see this method's own header for why this is not
    // the same value as the version-aware table above.
    await this.upsertAssignment(
      RuleCountryAssignment,
      { ruleId, countryId },
      { ruleId, countryId, assignedBy: legacyAssignedBy },
      { assignedAt: new Date(), assignedBy: legacyAssignedBy },
      transaction,
    );
  }

  /** See `applyRuleAssignment`'s own header for the `assignedBy`/`legacyAssignedBy` split —
   * `reward_country_assignments.assigned_by` carries the identical `fk_rwca_admin`. */
  private async applyRewardAssignment(
    rewardId: number,
    versionId: number,
    countryId: number,
    blastId: number,
    assignedBy: number,
    legacyAssignedBy: number | null,
    transaction: Transaction,
  ): Promise<void> {
    await this.scoped.update(
      RewardVersionCountryAssignment,
      { status: 'superseded', effectiveTo: new Date() },
      {
        where: { rewardId, countryId, status: 'active', rewardVersionId: { [Op.ne]: versionId } },
        transaction,
      },
    );

    await this.upsertAssignment(
      RewardVersionCountryAssignment,
      { rewardVersionId: versionId, countryId },
      { rewardVersionId: versionId, rewardId, countryId, blastId, status: 'active', assignedBy },
      {
        status: 'active',
        effectiveFrom: new Date(),
        effectiveTo: null,
        blastId,
        assignedBy,
        assignedAt: new Date(),
      },
      transaction,
    );

    // See `applyRuleAssignment`'s comment — identical legacy dual-write, reward side.
    await this.upsertAssignment(
      RewardCountryAssignment,
      { rewardId, countryId },
      { rewardId, countryId, assignedBy: legacyAssignedBy },
      { assignedAt: new Date(), assignedBy: legacyAssignedBy },
      transaction,
    );
  }

  /**
   * Find-or-create over `ScopedRepository`, the shape `RulesService.assignToCountry` already
   * establishes (T-031) for exactly this situation — `count` + a `create`/`update` branch,
   * never a bare `findOne`/`upsert` (both banned selector names under `no-raw-model-access`,
   * `scoped.repository.ts`'s own header). The `UniqueConstraintError` catch is the same
   * TOCTOU-narrowing backstop `assignToCountry` documents: a concurrent second blast racing
   * this one loses the insert and is treated as a successful update instead of surfacing an
   * error the caller did nothing wrong to deserve.
   */
  private async upsertAssignment(
    model: ModelStatic<Model>,
    where: Record<string, unknown>,
    createValues: Record<string, unknown>,
    updateValues: Record<string, unknown>,
    transaction: Transaction,
  ): Promise<void> {
    const existingCount = await this.scoped.count(model, { where, transaction });
    if (existingCount > 0) {
      await this.scoped.update(model, updateValues, { where, transaction });
      return;
    }
    try {
      await this.scoped.create(model, createValues as never, { transaction });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        await this.scoped.update(model, updateValues, { where, transaction });
        return;
      }
      throw error;
    }
  }

  // --- private: notification (implementation note 4's last step) -----------------------------

  /**
   * Best-effort — never throws, never blocks the blast response (`NotificationsService.notify`'s
   * own never-fail contract). A `country_admin`'s `portal_users` row always carries
   * `tenant_id IS NULL` (`ck_portal_users_scope`), but `portal_user_notifications.tenant_id` is
   * `NOT NULL` with a real FK to `reward_config.tenants` (`T040_001`'s own DDL) — a genuine,
   * disclosed structural gap this task did not create and `notifications/**` is outside this
   * task's `Files owned` to fix (AGENT-PROTOCOL R9). The narrowing applied here: any tenant
   * already in the target country stands in for "this country's own tenant" for the purpose of
   * satisfying the FK, since nothing downstream of `notify()` re-reads `tenant_id` to decide who
   * sees the notification (`NotificationsService.list` filters by `user_id` alone). A country
   * with zero tenants — no valid id exists to write — is skipped with a loud warning rather than
   * guessed at, the same "a gap in the log beats a wrong row in it" trade `AuditService`'s own
   * header states. Escalated in the completion report as a follow-up for whoever owns
   * `notifications/**` next.
   */
  private async notifyCountryAdmins(
    entityType: 'rule' | 'reward',
    entityId: number,
    versionNo: number,
    countries: readonly Country[],
  ): Promise<void> {
    for (const country of countries) {
      try {
        const admins = await this.scoped.listAll(PortalUser, {
          where: { role: 'country_admin', countryId: country.id, status: 'active' },
        });
        if (admins.length === 0) continue;

        const tenants = await this.scoped.listAll(Tenant, {
          where: { countryId: country.id },
          order: [['id', 'ASC']],
          limit: 1,
        });
        const tenantId = tenants[0]?.id;
        if (tenantId === undefined) {
          this.logger.warn(
            `Blast notification skipped for country ${String(country.id)}: no tenant exists ` +
              'yet to satisfy portal_user_notifications.tenant_id (NOT NULL FK). See ' +
              'BlastsService#notifyCountryAdmins for the full, disclosed reasoning.',
          );
          continue;
        }

        for (const admin of admins) {
          const input: NotifyInput = {
            tenantId,
            recipientPortalUserId: admin.id,
            // `notifications.constants.ts` (T-040, out of this task's `Files owned`) has no
            // 'version_blasted' entry in its `NotificationType` union, and adding one is a
            // one-line change this task may not make (AGENT-PROTOCOL R9). The column itself
            // carries no database CHECK constraint — that file's own header: "an
            // application-level whitelist rather than a transcribed database constraint" — so
            // this cast is safe at the data layer. Escalated in the completion report.
            notificationType: 'version_blasted' as unknown as NotificationType,
            title: `New ${entityType} version blasted`,
            message: `Version ${String(versionNo)} of this ${entityType} is now available in ${country.name}.`,
            entityType,
            entityId,
            entityLabel: country.name,
          };
          await this.notifications.notify(input);
        }
      } catch (error) {
        // Never allowed to fail the blast response — see the method's own header.
        this.logger.error(
          `Blast notification failed for country ${String(country.id)} — the blast itself ` +
            `already committed and is unaffected. Cause: ${(error as Error).message}`,
        );
      }
    }
  }

  private async toFullBlastDto(blast: VersionBlast): Promise<BlastDto> {
    const targets = await this.scoped.listAll(VersionBlastTarget, {
      where: { blastId: blast.id },
      include: [Country],
      order: [['id', 'ASC']],
    });
    return toBlastDto(blast, targets as (VersionBlastTarget & { country: Country })[]);
  }

  /** Mirrors `RuleVersionsService#resolveAdminUserId` (T-041). */
  private async resolveAdminUserId(actor: AuthenticatedUser): Promise<number | null> {
    const self = await this.scoped.findByPkOrFail(PortalUser, actor.userId);
    return self.adminUserId;
  }
}
