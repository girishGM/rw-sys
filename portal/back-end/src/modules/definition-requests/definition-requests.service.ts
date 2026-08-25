/**
 * T-042 — `/definition-requests`: a country or tenant asks Super Admin for a new or changed
 * rule/reward, and the resulting version links back to the request that caused it
 * (06-VERSIONING.md §9).
 *
 * ### The three layers behind every write here (`definition-requests.constants.ts`'s header)
 *
 * 1. **Permission** — `@RequirePermission(DEFINITION_REQUEST_ENTITY, …)` in the controller,
 *    backed by this task's own `role_entity_permissions` seed (`maker`/`checker`/`merchant` get
 *    no row at all — TC-4/TC-5).
 * 2. **`assertRole`** at the top of every mutating method here, independent of the controller.
 * 3. **Data** — `create()` never trusts the DTO for `requestingCountryId`/`requestingTenantId`;
 *    `ScopedRepository`'s `DefinitionRequest` scope-strategy entry forces both from the actor's
 *    own JWT scope on every write (TC-2), and every read is scoped the same way (TC-15/TC-17).
 *
 * ### Notification is best-effort, after the write commits
 *
 * Same shape and the same disclosed gap `BlastsService#notifyCountryAdmins` documents at length:
 * `portal_user_notifications.tenant_id` is `NOT NULL` with a real FK, but a `super_admin`'s own
 * `portal_users` row always carries `tenant_id IS NULL` (`ck_portal_users_scope`) — there is no
 * "their own tenant" to write. The narrowing applied here is the same one: any tenant that
 * exists anywhere stands in for the FK, since nothing downstream of `notify()` re-reads
 * `tenant_id` to decide who sees the notification. A system with zero tenants yet — skipped with
 * a loud warning, never a thrown error, exactly as `BlastsService` does. Also inherits that
 * file's other disclosed gap: `notifications.constants.ts` (T-040, outside this module's `Files
 * owned`) has no `'definition_request_submitted'`/`'definition_request_reviewed'`/
 * `'definition_request_fulfilled'` entries in its `NotificationType` union — the cast below is
 * safe at the data layer (that file's own header: "an application-level whitelist rather than a
 * transcribed database constraint") and is escalated in the completion report, same as T-041's.
 */
import { Injectable, Logger } from '@nestjs/common';
import { DefinitionRequest, RewardVersion, RuleVersion, Tenant } from '@/database/models';
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
  DEFAULT_PAGE_SIZE,
  DEFINITION_REQUEST_REVIEW_TRANSITIONS,
  MAX_PAGE_SIZE,
  type DefinitionRequestStatusValue,
} from './definition-requests.constants';
import {
  DefinitionRequestInvalidTransitionError,
  DefinitionRequestVersionNotPublishedError,
  EntityIdNotAllowedError,
  EntityIdRequiredError,
  RejectionCommentRequiredError,
} from './definition-requests.errors';
import type { CreateDefinitionRequestDto } from './dto/create-definition-request.dto';
import type { UpdateDefinitionRequestDto } from './dto/update-definition-request.dto';
import type { ReviewDefinitionRequestDto } from './dto/review-definition-request.dto';
import type { FulfilDefinitionRequestDto } from './dto/fulfil-definition-request.dto';
import type { ListDefinitionRequestsQueryDto } from './dto/list-definition-requests-query.dto';
import {
  toDefinitionRequestDto,
  type DefinitionRequestDto,
  type ListMeta,
} from './dto/definition-request-response.dto';

@Injectable()
export class DefinitionRequestsService {
  private readonly logger = new Logger(DefinitionRequestsService.name);

  constructor(
    private readonly scoped: ScopedRepository,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // --- reads (TC-15…TC-17, TC-21) -------------------------------------------------------------

  /** `GET /definition-requests` — newest first; scope-filtered (implementation note 7). Visibility
   * needs no `actor` parameter here — `ScopedRepository`'s `DefinitionRequest` scope-strategy
   * entry already covers all three visible roles uniformly (`country`/`tenant`/`super_admin`
   * unrestricted), the same "read visibility is derived, not branched" property
   * `RulesService.list` documents for `RuleMaster`. */
  async list(
    query: ListDefinitionRequestsQueryDto,
  ): Promise<{ rows: DefinitionRequestDto[]; meta: ListMeta }> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const where: Record<string, unknown> = {};
    if (query.status !== undefined) where['status'] = query.status;
    if (query.priority !== undefined) where['priority'] = query.priority;

    const rows = await this.scoped.listAll(DefinitionRequest, {
      where,
      order: [['createdAt', 'DESC']],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const total = await this.scoped.count(DefinitionRequest, { where });

    return { rows: rows.map(toDefinitionRequestDto), meta: { page, pageSize, total } };
  }

  /** `GET /definition-requests/:id` — requester + super_admin (TC-15: out-of-scope → 404). */
  async getById(id: number): Promise<DefinitionRequestDto> {
    const row = await this.findOrFail(id);
    return toDefinitionRequestDto(row);
  }

  // --- writes: the requester's side (TC-1…TC-9) ------------------------------------------------

  /** `POST /definition-requests` (implementation note 1, TC-1…TC-5). */
  async create(
    actor: AuthenticatedUser,
    dto: CreateDefinitionRequestDto,
  ): Promise<DefinitionRequestDto> {
    assertRole(actor, 'country_admin', 'tenant_admin');
    this.assertEntityIdMatchesType(dto.requestType, dto.entityId);

    const requestedBy = (await this.resolveAdminUserId(actor)) ?? actor.userId;

    const created = await this.scoped.create(DefinitionRequest, {
      requestType: dto.requestType,
      entityId: dto.entityId ?? null,
      requestedBy,
      // `ScopedRepository.create` overwrites whichever of these the actor's own scope axis
      // governs (TC-2); the other is explicitly `null` here rather than left to whatever a
      // stale local variable might hold.
      requestingCountryId: null,
      requestingTenantId: null,
      title: dto.title,
      description: dto.description,
      businessJustification: dto.businessJustification ?? null,
      desiredBy: dto.desiredBy ?? null,
      priority: dto.priority ?? 'normal',
      status: 'submitted',
      reviewedBy: null,
      reviewedAt: null,
      reviewComment: null,
      fulfilledVersionId: null,
      fulfilledAt: null,
    } as never);

    this.audit.annotate({
      targetId: created.id,
      targetType: 'definition_request',
      detail: { requestType: dto.requestType, entityId: dto.entityId ?? null },
    });

    // Best-effort, after the write above — see the file header.
    await this.notifyAllSuperAdmins(created);

    return toDefinitionRequestDto(await this.findOrFail(created.id));
  }

  /** `PATCH /definition-requests/:id` — requester, `submitted` only (TC-6/TC-7). */
  async update(
    actor: AuthenticatedUser,
    id: number,
    dto: UpdateDefinitionRequestDto,
  ): Promise<DefinitionRequestDto> {
    assertRole(actor, 'country_admin', 'tenant_admin');
    const before = await this.findOrFail(id);
    if (before.status !== 'submitted') {
      throw new DefinitionRequestInvalidTransitionError(
        before.status as DefinitionRequestStatusValue,
        'edit',
      );
    }

    const changes: Record<string, unknown> = {};
    if (dto.title !== undefined) changes['title'] = dto.title;
    if (dto.description !== undefined) changes['description'] = dto.description;
    if (dto.businessJustification !== undefined) {
      changes['businessJustification'] = dto.businessJustification;
    }
    if (dto.desiredBy !== undefined) changes['desiredBy'] = dto.desiredBy;
    if (dto.priority !== undefined) changes['priority'] = dto.priority;

    if (Object.keys(changes).length > 0) {
      const affected = await this.scoped.update(DefinitionRequest, changes, {
        where: { id, status: 'submitted' },
      });
      if (affected === 0) {
        throw new DefinitionRequestInvalidTransitionError(
          before.status as DefinitionRequestStatusValue,
          'edit',
        );
      }
    }

    const after = await this.findOrFail(id);
    this.audit.annotate({
      targetId: id,
      targetType: 'definition_request',
      detail: { changes: this.audit.diffFields(fieldSnapshot(before), fieldSnapshot(after)) },
    });
    return toDefinitionRequestDto(after);
  }

  /** `POST /definition-requests/:id/withdraw` — requester, `submitted` only (TC-8). */
  async withdraw(actor: AuthenticatedUser, id: number): Promise<DefinitionRequestDto> {
    assertRole(actor, 'country_admin', 'tenant_admin');
    const before = await this.findOrFail(id);

    const affected = await this.scoped.update(
      DefinitionRequest,
      { status: 'withdrawn' },
      { where: { id, status: 'submitted' } },
    );
    if (affected === 0) {
      throw new DefinitionRequestInvalidTransitionError(
        before.status as DefinitionRequestStatusValue,
        'withdrawn',
      );
    }

    const after = await this.findOrFail(id);
    this.audit.annotate({
      targetId: id,
      targetType: 'definition_request',
      detail: { event: 'withdrawn' },
    });
    return toDefinitionRequestDto(after);
  }

  // --- writes: Super Admin's side (TC-9…TC-14) --------------------------------------------------

  /** `POST /definition-requests/:id/review` — `super_admin` only (TC-9…TC-12). */
  async review(
    actor: AuthenticatedUser,
    id: number,
    dto: ReviewDefinitionRequestDto,
  ): Promise<DefinitionRequestDto> {
    assertRole(actor, 'super_admin');
    const before = await this.findOrFail(id);

    const legalTargets =
      DEFINITION_REQUEST_REVIEW_TRANSITIONS[before.status as DefinitionRequestStatusValue];
    if (!legalTargets.includes(dto.status)) {
      throw new DefinitionRequestInvalidTransitionError(
        before.status as DefinitionRequestStatusValue,
        dto.status,
      );
    }

    if (
      dto.status === 'rejected' &&
      (dto.reviewComment === undefined || dto.reviewComment.trim() === '')
    ) {
      throw new RejectionCommentRequiredError();
    }

    const reviewedBy = (await this.resolveAdminUserId(actor)) ?? actor.userId;
    const affected = await this.scoped.update(
      DefinitionRequest,
      {
        status: dto.status,
        reviewedBy,
        reviewedAt: new Date(),
        reviewComment: dto.reviewComment ?? null,
      },
      { where: { id, status: before.status } },
    );
    if (affected === 0) {
      throw new DefinitionRequestInvalidTransitionError(
        before.status as DefinitionRequestStatusValue,
        dto.status,
      );
    }

    const after = await this.findOrFail(id);
    this.audit.annotate({
      targetId: id,
      targetType: 'definition_request',
      detail: { event: 'reviewed', status: dto.status },
    });

    await this.notifyRequester(after, 'reviewed');
    return toDefinitionRequestDto(after);
  }

  /** `POST /definition-requests/:id/fulfil` — `super_admin` only, `approved` → `fulfilled`,
   * only with a **published** version (implementation notes 4/5, TC-13/TC-14). */
  async fulfil(
    actor: AuthenticatedUser,
    id: number,
    dto: FulfilDefinitionRequestDto,
  ): Promise<DefinitionRequestDto> {
    assertRole(actor, 'super_admin');
    const before = await this.findOrFail(id);
    if (before.status !== 'approved') {
      throw new DefinitionRequestInvalidTransitionError(
        before.status as DefinitionRequestStatusValue,
        'fulfilled',
      );
    }

    const isRule = before.requestType === 'new_rule' || before.requestType === 'update_rule';
    if (isRule) {
      const version = await this.scoped.findByPkOrFail(RuleVersion, dto.versionId);
      if (version.status !== 'published') throw new DefinitionRequestVersionNotPublishedError();
      await this.scoped.update(
        RuleVersion,
        { originRequestId: id },
        { where: { id: dto.versionId } },
      );
    } else {
      const version = await this.scoped.findByPkOrFail(RewardVersion, dto.versionId);
      if (version.status !== 'published') throw new DefinitionRequestVersionNotPublishedError();
      await this.scoped.update(
        RewardVersion,
        { originRequestId: id },
        { where: { id: dto.versionId } },
      );
    }

    const affected = await this.scoped.update(
      DefinitionRequest,
      { status: 'fulfilled', fulfilledVersionId: dto.versionId, fulfilledAt: new Date() },
      { where: { id, status: 'approved' } },
    );
    if (affected === 0) {
      throw new DefinitionRequestInvalidTransitionError(
        before.status as DefinitionRequestStatusValue,
        'fulfilled',
      );
    }

    const after = await this.findOrFail(id);
    this.audit.annotate({
      targetId: id,
      targetType: 'definition_request',
      detail: { event: 'fulfilled', versionId: dto.versionId },
    });

    await this.notifyRequester(after, 'fulfilled');
    return toDefinitionRequestDto(after);
  }

  // --- private helpers ---------------------------------------------------------------------

  private async findOrFail(id: number): Promise<DefinitionRequest> {
    return this.scoped.findByPkOrFail(DefinitionRequest, id);
  }

  /** `update_rule`/`update_reward` requires `entityId`; `new_rule`/`new_reward` forbids it —
   * checked here, not in the DTO (business rule about the *value*, see this file's own header). */
  private assertEntityIdMatchesType(requestType: string, entityId: number | undefined): void {
    const requiresEntityId = requestType === 'update_rule' || requestType === 'update_reward';
    if (requiresEntityId && entityId === undefined) throw new EntityIdRequiredError();
    if (!requiresEntityId && entityId !== undefined) throw new EntityIdNotAllowedError();
  }

  /** Mirrors `RulesService#resolveAdminUserId` (T-031) exactly — see that method's own comment
   * for the full `portal_users.admin_user_id` bridge reasoning. Duplicated rather than shared
   * across modules, the same choice every other Wave 3 service with this helper already makes. */
  private async resolveAdminUserId(actor: AuthenticatedUser): Promise<number | null> {
    const self = await this.scoped.findByPkOrFail(PortalUser, actor.userId);
    return self.adminUserId;
  }

  /**
   * Best-effort resolution of "the portal user who submitted this request", for notification
   * purposes only. `requestedBy` was written by {@link create} as
   * `resolveAdminUserId(actor) ?? actor.userId` — this is the reverse of that same fallback:
   * try a bridged `admin_user_id` match first, then fall back to treating the stored value as
   * already being a `portal_users.id` (the common case, since `admin_user_id` is null for most
   * fixtures in this system — same disclosed ambiguity `rule_versions.created_by` carries).
   * Returns `null`, never throws, when neither resolves — the caller treats that as "nobody to
   * notify", not as a failure.
   */
  private async resolveRequesterPortalUserId(request: DefinitionRequest): Promise<number | null> {
    const bridged = await this.scoped.listAll(PortalUser, {
      where: { adminUserId: request.requestedBy },
      limit: 1,
    });
    if (bridged[0] !== undefined) return bridged[0].id;

    try {
      const direct = await this.scoped.findByPkOrFail(PortalUser, request.requestedBy);
      return direct.id;
    } catch {
      return null;
    }
  }

  /** `tenant_id` for `NotifyInput` — see the file header's disclosed-gap note. */
  private async resolveNotifyTenantId(request: DefinitionRequest): Promise<number | undefined> {
    if (request.requestingTenantId !== null) return request.requestingTenantId;

    if (request.requestingCountryId !== null) {
      const tenants = await this.scoped.listAll(Tenant, {
        where: { countryId: request.requestingCountryId },
        order: [['id', 'ASC']],
        limit: 1,
      });
      if (tenants[0] !== undefined) return tenants[0].id;
    }

    const anyTenant = await this.scoped.listAll(Tenant, { order: [['id', 'ASC']], limit: 1 });
    return anyTenant[0]?.id;
  }

  /** On submit → every `super_admin` (implementation note 6, TC-20). Best-effort — see header. */
  private async notifyAllSuperAdmins(request: DefinitionRequest): Promise<void> {
    try {
      const admins = await this.scoped.listAll(PortalUser, {
        where: { role: 'super_admin', status: 'active' },
      });
      if (admins.length === 0) return;

      const tenantId = await this.resolveNotifyTenantId(request);
      if (tenantId === undefined) {
        this.logger.warn(
          'Definition-request submission notification skipped: no tenant exists yet to ' +
            'satisfy portal_user_notifications.tenant_id (NOT NULL FK). See ' +
            'DefinitionRequestsService#notifyAllSuperAdmins for the full, disclosed reasoning.',
        );
        return;
      }

      for (const admin of admins) {
        await this.notify(admin.id, tenantId, request, 'definition_request_submitted', 'submitted');
      }
    } catch (error) {
      this.logger.error(
        `Definition-request submission notification failed — the write itself already ` +
          `committed and is unaffected. Cause: ${(error as Error).message}`,
      );
    }
  }

  /** On review/fulfil → the requester (implementation note 6, TC-9/TC-11). Best-effort. */
  private async notifyRequester(
    request: DefinitionRequest,
    phase: 'reviewed' | 'fulfilled',
  ): Promise<void> {
    try {
      const recipientPortalUserId = await this.resolveRequesterPortalUserId(request);
      if (recipientPortalUserId === null) return;

      const tenantId = await this.resolveNotifyTenantId(request);
      if (tenantId === undefined) return;

      const notificationType =
        phase === 'reviewed' ? 'definition_request_reviewed' : 'definition_request_fulfilled';
      await this.notify(recipientPortalUserId, tenantId, request, notificationType, phase);
    } catch (error) {
      this.logger.error(
        `Definition-request ${phase} notification failed — the write itself already committed ` +
          `and is unaffected. Cause: ${(error as Error).message}`,
      );
    }
  }

  private async notify(
    recipientPortalUserId: number,
    tenantId: number,
    request: DefinitionRequest,
    notificationType: string,
    phase: 'submitted' | 'reviewed' | 'fulfilled',
  ): Promise<void> {
    const message =
      phase === 'submitted'
        ? `A new definition request "${request.title}" was submitted and needs triage.`
        : phase === 'reviewed'
          ? `Your definition request "${request.title}" was moved to ${request.status}.` +
            (request.reviewComment !== null ? ` Reason: ${request.reviewComment}` : '')
          : `Your definition request "${request.title}" was fulfilled.`;

    const input: NotifyInput = {
      tenantId,
      recipientPortalUserId,
      // `notifications.constants.ts` (T-040, out of this task's `Files owned`) has no
      // 'definition_request_*' entries in its `NotificationType` union — see the file header.
      notificationType: notificationType as unknown as NotificationType,
      title: `Definition request ${phase}`,
      message,
      entityType: 'definition_request',
      entityId: request.id,
      entityLabel: request.title,
    };
    await this.notifications.notify(input);
  }
}

/** The plain-object snapshot `AuditService.diffFields` compares. */
function fieldSnapshot(request: DefinitionRequest): Record<string, unknown> {
  return {
    title: request.title,
    description: request.description,
    businessJustification: request.businessJustification,
    desiredBy: request.desiredBy,
    priority: request.priority,
  };
}
