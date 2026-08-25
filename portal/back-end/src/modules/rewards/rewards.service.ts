/**
 * T-032 — `/rewards`: Super Admin authors global reward systems and policies; every other role
 * only reads what is assigned to their country (00-ARCHITECTURE.md §5.2, 01-DATABASE.md §4). The
 * reward equivalent of `rules.service.ts` (T-031) — see that file's header for the fuller
 * treatment of every point restated more briefly below.
 *
 * ### The three independent layers behind every reward-system write here
 *
 * 1. **Permission layer** — `role_entity_permissions` grants `reward:create/update/delete` and
 *    `reward_assignment:create/delete` to `super_admin` only (T004_001 seed). Enforced by
 *    `@RequirePermission` in `rewards.controller.ts`.
 * 2. **Service layer** — `assertRole(actor, 'super_admin')` at the top of every mutating method
 *    here, independent of what the permission table says (T-013's `assertRole`). Applied to the
 *    reward-system/country-assignment methods (the "may only Super Admin author rules/rewards"
 *    product rule this task and T-031 both exist to enforce) and, as defence in depth, to the
 *    policy/cap sub-resource methods too, even though those routes are additionally hard-gated
 *    with `@Roles('super_admin')` rather than a `role_entity_permissions` row (no such row
 *    exists for `reward_policy`/`reward_policy_cap` — see `rewards.controller.ts`'s header).
 * 3. **Data layer** — every reward-system write below sets `tenant_id = NULL` explicitly (never
 *    inferred), and every read/write routes through `ScopedRepository`, whose `RewardSystem`/
 *    `RewardPolicy`/`RewardCountryAssignment` scope-strategy entries (T-013,
 *    `common/scope/scope-strategy.ts`) make a non-super-admin actor structurally unable to reach
 *    this service's write paths at all.
 *
 * ### `connector_config` — the one thing `rules.service.ts` has no equivalent of
 *
 * See `reward-connector-config.crypto.ts`'s header for the full encryption design and the
 * design-doc/task-file conflict it flags. In short: encrypted before every write, decrypted and
 * masked on a detail read only, absent entirely from a list read, and excluded from the audit
 * `field_changes` diff (only *that* it changed, never the value) — implementation note 4.
 */
import { Inject, Injectable } from '@nestjs/common';
import { UniqueConstraintError } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { Country, RewardCountryAssignment, RewardPolicy, RewardSystem } from '@/database/models';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { PortalUser } from '@/database/portal-models';
import { assertRole } from '@/common/rbac/assert-role';
import { AuditService } from '@/common/audit/audit.service';
import { NotFoundError } from '@/common/errors/app-error';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { findActiveCampaignsUsingRewardInCountry } from './campaign-usage.query';
import { RewardConnectorConfigCrypto } from './reward-connector-config.crypto';
import {
  findRewardPolicyCap,
  insertRewardPolicyCap,
  listRewardPolicyCaps,
  updateRewardPolicyCap,
} from './reward-policy-caps.repository';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './rewards.constants';
import {
  RewardHasCountryAssignmentsError,
  RewardInUseByCampaignError,
  RewardPolicyCodeExistsError,
  RewardSystemCodeExistsError,
} from './rewards.errors';
import type { AssignRewardCountryDto } from './dto/assign-reward-country.dto';
import type { CreateRewardDto } from './dto/create-reward.dto';
import type { RewardSortField, ListRewardsQueryDto } from './dto/list-rewards-query.dto';
import type { UpdateRewardDto } from './dto/update-reward.dto';
import type {
  CreateRewardPolicyCapDto,
  UpdateRewardPolicyCapDto,
} from './dto/reward-policy-cap.dto';
import {
  toRewardPolicyCapDto,
  type RewardPolicyCapDto,
} from './dto/reward-policy-cap-response.dto';
import type { CreateRewardPolicyDto, UpdateRewardPolicyDto } from './dto/reward-policy.dto';
import { toRewardPolicyDto, type RewardPolicyDto } from './dto/reward-policy-response.dto';
import {
  toRewardCountryAssignmentDto,
  toRewardDto,
  toRewardListItemDto,
  type ListMeta,
  type RewardCountryAssignmentDto,
  type RewardDto,
  type RewardListItemDto,
} from './dto/reward-response.dto';

const SORT_COLUMN: Readonly<Record<RewardSortField, string>> = Object.freeze({
  systemCode: 'systemCode',
  name: 'name',
  createdAt: 'createdAt',
  status: 'status',
});

@Injectable()
export class RewardsService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly audit: AuditService,
    private readonly connectorConfigCrypto: RewardConnectorConfigCrypto,
  ) {}

  // --- reward systems: reads ---------------------------------------------------------------

  /**
   * `GET /rewards` (list). Visibility is decided entirely by `ScopedRepository` (see this file's
   * header). `tenantId: null` is forced on top regardless of role, exactly as
   * `rules.service.ts#list` does: this endpoint's whole purpose is the portal-managed catalogue
   * of **global** rewards, and a legacy tenant-local `reward_systems` row this portal does not
   * author must never appear in it. `connectorConfig` is never fetched or returned here (TC-11).
   */
  async list(query: ListRewardsQueryDto): Promise<{ rows: RewardListItemDto[]; meta: ListMeta }> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const [field, direction] = parseSort(query.sort);

    const where: Record<string, unknown> = { tenantId: null };
    if (query.status !== undefined) where['status'] = query.status;

    const rows = await this.scoped.listAll(RewardSystem, {
      where,
      order: [[SORT_COLUMN[field], direction.toUpperCase()]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const total = await this.scoped.count(RewardSystem, { where });

    return {
      rows: rows.map((row) => toRewardListItemDto(row)),
      meta: { page, pageSize, total },
    };
  }

  /** `GET /rewards/:id`. 404 for absent **or** out-of-scope (`ScopedRepository.findByPkOrFail`).
   * `connectorConfig` is decrypted and masked, never returned raw (TC-12). */
  async getById(id: number): Promise<RewardDto> {
    const reward = await this.findGlobalRewardOrFail(id);
    const decrypted = this.connectorConfigCrypto.decryptForRow(reward.id, reward.connectorConfig);
    return toRewardDto(reward, decrypted);
  }

  /** `GET /rewards/:id/countries`. `super_admin` only (enforced at the controller). */
  async listCountryAssignments(rewardId: number): Promise<RewardCountryAssignmentDto[]> {
    await this.findGlobalRewardOrFail(rewardId);
    const rows = await this.scoped.listAll(RewardCountryAssignment, {
      where: { rewardId },
      include: [Country],
      order: [['assignedAt', 'ASC']],
    });
    return rows.map((row) =>
      toRewardCountryAssignmentDto(row as RewardCountryAssignment & { country: Country }),
    );
  }

  // --- reward systems: writes ----------------------------------------------------------------

  /**
   * `POST /rewards`. Layer 2 + layer 3 of this file's header.
   *
   * ### Why `systemCode` uniqueness is checked here, not left to `uc_reward_system_code` alone
   *
   * Same TOCTOU-narrowing trade-off `rules.service.ts#create` documents for `uq_rm_tenant_code`:
   * `uc_reward_system_code` is `(tenant_id, system_code)`, and Postgres's default `NULLS
   * DISTINCT` behaviour treats every `NULL` `tenant_id` as distinct from every other, so two
   * global rewards can share a `systemCode` without tripping the constraint. The explicit
   * pre-check narrows, but does not close, the race; the `UniqueConstraintError` catch below is
   * the defence-in-depth second layer for the case where it does fire.
   *
   * ### `connectorConfig` — two-phase encryption
   *
   * See `reward-connector-config.crypto.ts`'s header. When `dto.connectorConfig` is supplied,
   * the row is inserted with a provisional envelope, then immediately re-encrypted under its now
   * -known id and updated, both inside one transaction — so a reader can never observe the
   * provisional (un-rebound) ciphertext.
   */
  async create(actor: AuthenticatedUser, dto: CreateRewardDto): Promise<RewardDto> {
    assertRole(actor, 'super_admin');

    const duplicateCount = await this.scoped.count(RewardSystem, {
      where: { tenantId: null, systemCode: dto.systemCode },
    });
    if (duplicateCount > 0) throw new RewardSystemCodeExistsError();

    const created = await this.sequelize.transaction(async (transaction) => {
      let row: RewardSystem;
      try {
        row = await this.scoped.create(
          RewardSystem,
          {
            // Explicit, not inferred — layer 3 of this file's header.
            tenantId: null,
            merchantId: dto.merchantId ?? null,
            systemCode: dto.systemCode,
            name: dto.name.trim(),
            description: dto.description ?? null,
            rewardType: dto.rewardType,
            deliveryMode: dto.deliveryMode ?? 'realtime',
            connectorType: dto.connectorType,
            connectorConfig:
              dto.connectorConfig === undefined
                ? undefined
                : this.connectorConfigCrypto.encryptForNewRow(dto.connectorConfig),
            maintenanceWindowEnabled: dto.maintenanceWindowEnabled ?? false,
            maintenanceSchedule: dto.maintenanceSchedule ?? {},
            retryEnabled: dto.retryEnabled ?? true,
            retryConfig: dto.retryConfig ?? {},
            status: 'active',
            // `as never` — the same `sequelize-typescript`/`CreationAttributes<M>` gap
            // `rules.service.ts#create` documents at length.
          } as never,
          { transaction },
        );
      } catch (error) {
        if (error instanceof UniqueConstraintError) {
          throw new RewardSystemCodeExistsError({ cause: error });
        }
        throw error;
      }

      if (dto.connectorConfig !== undefined) {
        const rebound = this.connectorConfigCrypto.rebindToRow(row.id, row.connectorConfig);
        await this.scoped.update(RewardSystem, { connectorConfig: rebound } as never, {
          where: { id: row.id, tenantId: null },
          transaction,
        });
      }

      return row;
    });

    this.audit.annotate({ targetId: created.id, detail: { systemCode: created.systemCode } });
    return this.getById(created.id);
  }

  /**
   * `PATCH /rewards/:id`. Layer 2 + layer 3. Audited with a field diff that excludes
   * `connectorConfig`'s value — only that it changed (implementation note 4, TC-13).
   */
  async update(actor: AuthenticatedUser, id: number, dto: UpdateRewardDto): Promise<RewardDto> {
    assertRole(actor, 'super_admin');

    const before = await this.findGlobalRewardOrFail(id);
    const connectorConfigChanged = dto.connectorConfig !== undefined;
    const changes = collectRewardChanges(dto);
    if (connectorConfigChanged) {
      changes['connectorConfig'] = this.connectorConfigCrypto.encryptForRow(
        id,
        dto.connectorConfig as Record<string, unknown>,
      );
    }

    if (Object.keys(changes).length > 0) {
      await this.scoped.update(RewardSystem, changes, { where: { id, tenantId: null } });
    }

    const after = await this.findGlobalRewardOrFail(id);
    this.audit.annotate({
      targetId: id,
      detail: {
        changes: this.audit.diffFields(fieldSnapshot(before), fieldSnapshot(after)),
        connectorConfigChanged,
      },
    });

    const decrypted = this.connectorConfigCrypto.decryptForRow(after.id, after.connectorConfig);
    return toRewardDto(after, decrypted);
  }

  /**
   * `DELETE /rewards/:id`. Layer 2 + layer 3. Refuses while any country assignment remains
   * (TC-20), listing the blocking country ids. `reward_systems` is `paranoid: true`
   * (`reward-system.model.ts`) — this is a soft delete, unlike `rules.service.ts#remove`'s hard
   * delete on the non-paranoid `rule_master`.
   */
  async remove(actor: AuthenticatedUser, id: number): Promise<void> {
    assertRole(actor, 'super_admin');
    await this.findGlobalRewardOrFail(id);

    const assignments = await this.scoped.listAll(RewardCountryAssignment, {
      where: { rewardId: id },
    });
    if (assignments.length > 0) {
      throw new RewardHasCountryAssignmentsError(assignments.map((row) => row.countryId));
    }

    await this.scoped.destroy(RewardSystem, { where: { id, tenantId: null } });
    this.audit.annotate({ targetId: id, detail: { event: 'reward_deleted' } });
  }

  /**
   * `POST /rewards/:id/countries`. Layer 2 + layer 3. Idempotent (mirrors
   * `rules.service.ts#assignToCountry`'s TC-11 equivalent): assigning the same reward to the
   * same country twice returns the existing row rather than a duplicate.
   */
  async assignToCountry(
    actor: AuthenticatedUser,
    rewardId: number,
    dto: AssignRewardCountryDto,
  ): Promise<RewardCountryAssignmentDto> {
    assertRole(actor, 'super_admin');
    await this.findGlobalRewardOrFail(rewardId);
    // 404s a bogus/out-of-scope country id before any write is attempted.
    await this.scoped.findByPkOrFail(Country, dto.countryId);
    const assignedBy = await this.resolveAdminUserId(actor);

    return this.sequelize.transaction(async (transaction) => {
      const alreadyAssignedCount = await this.scoped.count(RewardCountryAssignment, {
        where: { rewardId, countryId: dto.countryId },
        transaction,
      });
      if (alreadyAssignedCount > 0) {
        const existing = await this.scoped.findOneOrFail(RewardCountryAssignment, {
          where: { rewardId, countryId: dto.countryId },
          include: [Country],
          transaction,
        });
        return toRewardCountryAssignmentDto(
          existing as RewardCountryAssignment & { country: Country },
        );
      }

      let created: RewardCountryAssignment;
      try {
        created = await this.scoped.create(
          RewardCountryAssignment,
          { rewardId, countryId: dto.countryId, assignedBy } as never,
          { transaction },
        );
      } catch (error) {
        // A concurrent request won the race between the count above and this insert —
        // `uq_rewa_country_assignments` is the backstop. Re-read rather than surface a 409 for
        // what is, from the caller's point of view, a successful assign.
        if (error instanceof UniqueConstraintError) {
          const raced = await this.scoped.findOneOrFail(RewardCountryAssignment, {
            where: { rewardId, countryId: dto.countryId },
            include: [Country],
            transaction,
          });
          this.audit.annotate({
            targetId: raced.id,
            targetType: 'reward_assignment',
            detail: { rewardId, countryId: dto.countryId },
          });
          return toRewardCountryAssignmentDto(
            raced as RewardCountryAssignment & { country: Country },
          );
        }
        throw error;
      }

      this.audit.annotate({
        targetId: created.id,
        targetType: 'reward_assignment',
        detail: { rewardId, countryId: dto.countryId },
      });
      const withCountry = await this.scoped.findOneOrFail(RewardCountryAssignment, {
        where: { id: created.id },
        include: [Country],
        transaction,
      });
      return toRewardCountryAssignmentDto(
        withCountry as RewardCountryAssignment & { country: Country },
      );
    });
  }

  /**
   * `DELETE /rewards/:id/countries/:countryId`. Layer 2 + layer 3. Refuses when an active
   * campaign in `countryId` is bound to `rewardId` (TC-9) — 422 listing the blocking campaigns;
   * the assignment row is left untouched.
   */
  async unassignFromCountry(
    actor: AuthenticatedUser,
    rewardId: number,
    countryId: number,
  ): Promise<void> {
    assertRole(actor, 'super_admin');
    await this.findGlobalRewardOrFail(rewardId);

    const assignment = await this.scoped.findOneOrFail(RewardCountryAssignment, {
      where: { rewardId, countryId },
    });

    const campaigns = await findActiveCampaignsUsingRewardInCountry(
      this.sequelize,
      rewardId,
      countryId,
    );
    if (campaigns.length > 0) {
      throw new RewardInUseByCampaignError(campaigns);
    }

    await this.scoped.destroy(RewardCountryAssignment, { where: { id: assignment.id } });
    this.audit.annotate({
      targetId: assignment.id,
      targetType: 'reward_assignment',
      detail: { rewardId, countryId },
    });
  }

  // --- reward_policies: super_admin only (03-API-CONTRACT.md §9) -----------------------------

  async listPolicies(rewardId: number): Promise<RewardPolicyDto[]> {
    await this.findGlobalRewardOrFail(rewardId);
    const rows = await this.scoped.listAll(RewardPolicy, {
      where: { rewardSystemId: rewardId },
      order: [['policyCode', 'ASC']],
    });
    return rows.map(toRewardPolicyDto);
  }

  /** Same TOCTOU-narrowing trade-off as {@link create}'s `systemCode` check, for
   * `uq_rp_system_code` (TC-18). */
  async createPolicy(
    actor: AuthenticatedUser,
    rewardId: number,
    dto: CreateRewardPolicyDto,
  ): Promise<RewardPolicyDto> {
    assertRole(actor, 'super_admin');
    await this.findGlobalRewardOrFail(rewardId);

    const duplicateCount = await this.scoped.count(RewardPolicy, {
      where: { rewardSystemId: rewardId, policyCode: dto.policyCode },
    });
    if (duplicateCount > 0) throw new RewardPolicyCodeExistsError();

    let created: RewardPolicy;
    try {
      created = await this.scoped.create(RewardPolicy, {
        rewardSystemId: rewardId,
        policyCode: dto.policyCode,
        name: dto.name.trim(),
        description: dto.description ?? null,
        config: dto.config ?? {},
        status: 'active',
      } as never);
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new RewardPolicyCodeExistsError({ cause: error });
      }
      throw error;
    }

    this.audit.annotate({
      targetId: created.id,
      targetType: 'reward_policy',
      detail: { rewardId, policyCode: created.policyCode },
    });
    return toRewardPolicyDto(created);
  }

  async updatePolicy(
    actor: AuthenticatedUser,
    rewardId: number,
    policyId: number,
    dto: UpdateRewardPolicyDto,
  ): Promise<RewardPolicyDto> {
    assertRole(actor, 'super_admin');
    await this.findGlobalRewardOrFail(rewardId);
    await this.scoped.findByPkOrFail(RewardPolicy, policyId, {
      where: { rewardSystemId: rewardId },
    });

    const changes: Record<string, unknown> = {};
    if (dto.name !== undefined) changes['name'] = dto.name.trim();
    if (dto.description !== undefined) changes['description'] = dto.description;
    if (dto.config !== undefined) changes['config'] = dto.config;
    if (dto.status !== undefined) changes['status'] = dto.status;

    if (Object.keys(changes).length > 0) {
      await this.scoped.update(RewardPolicy, changes, {
        where: { id: policyId, rewardSystemId: rewardId },
      });
    }

    const after = await this.scoped.findByPkOrFail(RewardPolicy, policyId, {
      where: { rewardSystemId: rewardId },
    });
    this.audit.annotate({
      targetId: policyId,
      targetType: 'reward_policy',
      detail: { rewardId },
    });
    return toRewardPolicyDto(after);
  }

  // --- reward_policy_caps: super_admin only (implementation note 5) --------------------------

  async listPolicyCaps(rewardId: number, policyId: number): Promise<RewardPolicyCapDto[]> {
    const policy = await this.findRewardPolicyOrFail(rewardId, policyId);
    const rows = await listRewardPolicyCaps(this.sequelize, policy.id);
    return rows.map(toRewardPolicyCapDto);
  }

  async createPolicyCap(
    actor: AuthenticatedUser,
    rewardId: number,
    policyId: number,
    dto: CreateRewardPolicyCapDto,
  ): Promise<RewardPolicyCapDto> {
    assertRole(actor, 'super_admin');
    const policy = await this.findRewardPolicyOrFail(rewardId, policyId);

    const created = await insertRewardPolicyCap(this.sequelize, {
      rewardPolicyId: policy.id,
      capType: dto.capType,
      frequencyValue: dto.frequencyValue ?? null,
      frequencyUnit: dto.frequencyUnit ?? null,
      maxOccurrences: dto.maxOccurrences ?? null,
      maxTotalAmount: dto.maxTotalAmount ?? null,
    });

    this.audit.annotate({
      targetId: created.id,
      targetType: 'reward_policy_cap',
      detail: { rewardId, policyId, capType: created.capType },
    });
    return toRewardPolicyCapDto(created);
  }

  async updatePolicyCap(
    actor: AuthenticatedUser,
    rewardId: number,
    policyId: number,
    capId: number,
    dto: UpdateRewardPolicyCapDto,
  ): Promise<RewardPolicyCapDto> {
    assertRole(actor, 'super_admin');
    const policy = await this.findRewardPolicyOrFail(rewardId, policyId);

    const existing = await findRewardPolicyCap(this.sequelize, capId, policy.id);
    if (existing === null) {
      throw new NotFoundError();
    }

    const changes: Record<string, unknown> = {};
    if (dto.frequencyValue !== undefined) changes['frequencyValue'] = dto.frequencyValue;
    if (dto.frequencyUnit !== undefined) changes['frequencyUnit'] = dto.frequencyUnit;
    if (dto.maxOccurrences !== undefined) changes['maxOccurrences'] = dto.maxOccurrences;
    if (dto.maxTotalAmount !== undefined) changes['maxTotalAmount'] = dto.maxTotalAmount;
    if (dto.status !== undefined) changes['status'] = dto.status;

    const updated = await updateRewardPolicyCap(this.sequelize, capId, policy.id, changes);
    if (updated === null) {
      throw new NotFoundError();
    }

    this.audit.annotate({
      targetId: capId,
      targetType: 'reward_policy_cap',
      detail: { rewardId, policyId },
    });
    return toRewardPolicyCapDto(updated);
  }

  // --- private helpers -----------------------------------------------------------------------

  private async findGlobalRewardOrFail(id: number): Promise<RewardSystem> {
    return this.scoped.findByPkOrFail(RewardSystem, id, { where: { tenantId: null } });
  }

  private async findRewardPolicyOrFail(rewardId: number, policyId: number): Promise<RewardPolicy> {
    await this.findGlobalRewardOrFail(rewardId);
    return this.scoped.findByPkOrFail(RewardPolicy, policyId, {
      where: { rewardSystemId: rewardId },
    });
  }

  /**
   * `reward_country_assignments.assigned_by` carries a real FK to `reward_config.admin_users(id)`
   * — the same disjoint-id-space gap `rules.service.ts#resolveAdminUserId` documents at length
   * for `rule_country_assignments.assigned_by`. Resolves the sanctioned `portal_users.
   * admin_user_id` bridge, returning `null` when none exists (every `super_admin` account T-004's
   * bootstrap CLI creates today).
   */
  private async resolveAdminUserId(actor: AuthenticatedUser): Promise<number | null> {
    const self = await this.scoped.findByPkOrFail(PortalUser, actor.userId);
    return self.adminUserId;
  }
}

// --- module-private helpers --------------------------------------------------------------------

function parseSort(sort: string | undefined): [RewardSortField, 'asc' | 'desc'] {
  if (sort === undefined) return ['name', 'asc'];
  const [field, direction] = sort.split(':') as [RewardSortField, 'asc' | 'desc'];
  return [field, direction];
}

/** Only the columns the caller actually supplied — `systemCode` is immutable, never here.
 * `connectorConfig` is handled separately by the caller (encryption needs the row's id). */
function collectRewardChanges(dto: UpdateRewardDto): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (dto.name !== undefined) changes['name'] = dto.name.trim();
  if (dto.description !== undefined) changes['description'] = dto.description;
  if (dto.rewardType !== undefined) changes['rewardType'] = dto.rewardType;
  if (dto.deliveryMode !== undefined) changes['deliveryMode'] = dto.deliveryMode;
  if (dto.connectorType !== undefined) changes['connectorType'] = dto.connectorType;
  if (dto.maintenanceWindowEnabled !== undefined) {
    changes['maintenanceWindowEnabled'] = dto.maintenanceWindowEnabled;
  }
  if (dto.maintenanceSchedule !== undefined)
    changes['maintenanceSchedule'] = dto.maintenanceSchedule;
  if (dto.retryEnabled !== undefined) changes['retryEnabled'] = dto.retryEnabled;
  if (dto.retryConfig !== undefined) changes['retryConfig'] = dto.retryConfig;
  if (dto.merchantId !== undefined) changes['merchantId'] = dto.merchantId;
  if (dto.status !== undefined) changes['status'] = dto.status;
  return changes;
}

/** The plain-object snapshot `AuditService.diffFields` compares. `connectorConfig` is
 * deliberately excluded — implementation note 4: "exclude it from audit `field_changes` —
 * record only that it changed" (TC-13); the caller adds `connectorConfigChanged` separately. */
function fieldSnapshot(reward: RewardSystem): Record<string, unknown> {
  return {
    name: reward.name,
    description: reward.description,
    rewardType: reward.rewardType,
    deliveryMode: reward.deliveryMode,
    connectorType: reward.connectorType,
    maintenanceWindowEnabled: reward.maintenanceWindowEnabled,
    maintenanceSchedule: reward.maintenanceSchedule,
    retryEnabled: reward.retryEnabled,
    retryConfig: reward.retryConfig,
    merchantId: reward.merchantId,
    status: reward.status,
  };
}
