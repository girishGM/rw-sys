/**
 * T-038 — `/approvals`: the checker's queue, the payload diff, and the three decisions.
 *
 * ### Segregation of duty is the reason this file exists
 *
 * Everything else here — pagination, name resolution, the diff — is plumbing around one sentence
 * from the task file: *"Even a user who legitimately holds both maker and checker duties cannot
 * approve their own work — that is the entire point of the control."* Three things make that
 * structural rather than aspirational:
 *
 *  1. **It is checked in the service, not the controller and not the SPA.** {@link decide} is the
 *     single entry point for all three decisions, and the check is its first statement after the
 *     row is loaded. A `curl` straight at `POST /approvals/:id/approve` (TC-6, TC-17) runs exactly
 *     the same line the button does.
 *  2. **It applies to all three decisions, not just `approve`.** Rejecting or returning your own
 *     submission is self-review too. A maker who wants a submission back has
 *     `POST /campaigns/:id/submit`'s own state machine, not the checker's queue.
 *  3. **It is compared against the verified JWT** (`actor.userId`, populated by `JwtAuthGuard`),
 *     never against anything in the body — the DTOs have no actor field at all (R3).
 *
 * ### The three independent layers, as everywhere else in Wave 3
 *
 *  1. **Permission layer** — `role_entity_permissions` grants `approval:['view','approve',
 *     'reject']` to `checker`, `approval:['view']` to `super_admin`/`country_admin`/
 *     `tenant_admin`/`maker`, and **no `approval` row at all** to `merchant`. That is TC-1, TC-2
 *     and TC-3 without a branch in this file. `return` rides on `campaign:return` — see
 *     `approvals.constants.ts#RETURN_ENTITY` for why.
 *  2. **Service layer** — `assertRole(actor, 'checker')` at the top of {@link decide}, independent
 *     of what that table says (TC-17, TC-18: a `maker` or `tenant_admin` who was granted
 *     `approval:approve` by a direct `UPDATE` still gets 403).
 *  3. **Data layer** — `ScopedRepository`'s strategy for `PortalApprovalRequest` is
 *     `tenant_id = <actor's tenant>`, so a checker in tenant B cannot read, let alone decide,
 *     tenant A's request: it is a 404, indistinguishable from "no such request" (TC-4).
 *
 * ### Why the decision transaction is ordered the way it is
 *
 * Implementation note 3: *"a partial commit here would leave an approved request over a draft
 * campaign — the worst possible inconsistency in this workflow."* So {@link decide} does all of
 * it — request row, campaign row, audit row — in one `sequelize.transaction`, and the only step
 * left outside is the maker's notification, because a notification failure must not roll back a
 * valid decision (the same split `CampaignsService.submit` makes, for the same reason).
 *
 * Inside the transaction the order is:
 *
 *  1. `SELECT … FOR UPDATE` on the request row (note 6). Two checkers racing serialise here.
 *  2. Self-approval → 422, **before** anything else is read or written (note 2).
 *  3. Entity type, already-decided, expired → 409 (notes 5 and 6).
 *  4. Conditional `UPDATE … WHERE status = 'pending'`; zero rows changed → 409. A lock and a
 *     guarded write fail in different ways and neither alone is a proof — see
 *     `approvals.errors.ts#ApprovalAlreadyDecidedError`.
 *  5. Campaign transition through `assertTransition`, then the campaign row.
 *  6. `recordOrFail` audit — a decision with no trace of who made it is a governance failure, not
 *     an inconvenience, so unlike an ordinary edit this one *does* fail the request (TC-23).
 */
import { Inject, Injectable } from '@nestjs/common';
import { Op, type WhereOptions } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { TenantCampaign } from '@/database/models';
import { PortalApprovalRequest, PortalUser } from '@/database/portal-models';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { assertRole } from '@/common/rbac/assert-role';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { NOTIFICATION_TYPE } from '@/modules/notifications/notifications.constants';
import {
  isApprovalExpired,
  type ApprovalDetail,
  type ApprovalRequest,
} from '@reward-portal/shared';
import { actorRefText } from '@/modules/campaigns/actor-ref';
import { CampaignAuditService } from '@/modules/campaigns/campaign-audit.service';
import {
  assertTransition,
  type CampaignTransition,
} from '@/modules/campaigns/campaign-state-machine';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  CAMPAIGN_STATUS,
} from '@/modules/campaigns/campaigns.constants';
import { ChangeEventPublisher } from '@/grpc/change-event.publisher';
import { buildApprovalDiff, type DiffSubject } from './approval-diff';
import {
  APPROVAL_DECISION,
  APPROVAL_ENTITY_CAMPAIGN,
  APPROVAL_STATUS,
  DEFAULT_PAGE_SIZE,
  MAX_NAME_LOOKUPS,
  MAX_PAGE_SIZE,
  type ApprovalDecision,
} from './approvals.constants';
import {
  ApprovalAlreadyDecidedError,
  ApprovalExpiredError,
  ApprovalSubjectUnsupportedError,
  SelfApprovalForbiddenError,
} from './approvals.errors';
import {
  toApprovalDetailDto,
  toApprovalDto,
  type ApprovalRowContext,
  type ListMeta,
} from './dto/approval-response.dto';
import type { ListApprovalsQueryDto } from './dto/approval.dto';

/** What one decision does, in the three places that differ between them. */
interface DecisionShape {
  /** The status written to `portal_approval_requests.status`. */
  readonly requestStatus: string;
  /** The verb `campaign-state-machine.ts` knows this decision by. */
  readonly transition: CampaignTransition;
  /** `ck_pcat_action` — see `campaigns.constants.ts#AUDIT_ACTION` on why `return` has no value. */
  readonly auditAction: (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];
  readonly notificationType: (typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE];
  readonly notificationTitle: string;
  /** Whether `comment` is mandatory (implementation note 4, TC-8/TC-10). */
  readonly requiresComment: boolean;
}

const DECISIONS: Readonly<Record<ApprovalDecision, DecisionShape>> = Object.freeze({
  [APPROVAL_DECISION.APPROVE]: {
    requestStatus: APPROVAL_STATUS.APPROVED,
    transition: 'approve',
    auditAction: AUDIT_ACTION.APPROVED,
    notificationType: NOTIFICATION_TYPE.CAMPAIGN_APPROVED,
    notificationTitle: 'Campaign approved',
    requiresComment: false,
  },
  [APPROVAL_DECISION.REJECT]: {
    requestStatus: APPROVAL_STATUS.REJECTED,
    transition: 'reject',
    auditAction: AUDIT_ACTION.REJECTED,
    notificationType: NOTIFICATION_TYPE.CAMPAIGN_REJECTED,
    notificationTitle: 'Campaign rejected',
    requiresComment: true,
  },
  [APPROVAL_DECISION.RETURN]: {
    requestStatus: APPROVAL_STATUS.RETURNED,
    transition: 'return',
    // `ck_pcat_action` permits no `returned` value and R1 forbids widening it; the decision is
    // carried in `field_changes` instead. See `campaigns.constants.ts#AUDIT_ACTION`.
    auditAction: AUDIT_ACTION.STATUS_CHANGED,
    notificationType: NOTIFICATION_TYPE.CAMPAIGN_RETURNED,
    notificationTitle: 'Campaign returned for rework',
    requiresComment: true,
  },
});

/** What a completed decision needs after the transaction closes, to notify the maker. */
interface DecisionOutcome {
  readonly request: PortalApprovalRequest;
  readonly campaign: TenantCampaign;
  /** `requested_by` — a `portal_users.id`, the recipient of the notification below. */
  readonly makerId: number;
}

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly audit: CampaignAuditService,
    private readonly notifications: NotificationsService,
    // T-047 — 09-INTEGRATION.md §9: *"Checker approves → active → ConfigChangeEvent UPDATED"*. The
    // approval is the moment a campaign's configuration becomes real to the transaction runtime,
    // and this is the only place in the codebase that moment happens.
    private readonly changeEvents: ChangeEventPublisher,
  ) {}

  // --- reads ---------------------------------------------------------------------------------

  /**
   * `GET /approvals` — the queue (TC-1, TC-24).
   *
   * No role branch: `ScopedRepository` decides which rows exist for this caller, and
   * `toApprovalDto` decides which of them this caller may *decide*. A `maker` therefore gets the
   * same rows a `checker` in the same tenant gets, with `decidable: false` on every one of them
   * — TC-2's *"read-only view; no approve/reject controls"*, expressed as data rather than as a
   * second query.
   */
  async list(
    actor: AuthenticatedUser,
    query: ListApprovalsQueryDto,
  ): Promise<{ rows: ApprovalRequest[]; meta: ListMeta }> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const where = buildWhere(query);

    const rows = await this.scoped.listAll(PortalApprovalRequest, {
      where,
      order: [
        ['requestedAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const total = await this.scoped.count(PortalApprovalRequest, { where });

    const context = await this.contextFor(rows);
    // One instant for the whole page — see `toApprovalDto`'s own comment on why `now` is a
    // parameter rather than a `new Date()` per row.
    const now = new Date();

    return {
      rows: rows.map((row) => toApprovalDto(row, actor, context(row), now)),
      meta: { page, pageSize, total },
    };
  }

  /**
   * `GET /approvals/:id` — the request plus its rendered diff (TC-19, TC-20).
   *
   * A request in another tenant 404s here rather than 403ing, and the two are indistinguishable
   * by construction because `findByPkOrFail` never loads the row at all (TC-4,
   * 02-SECURITY.md §5.1).
   */
  async getDetail(actor: AuthenticatedUser, id: number): Promise<ApprovalDetail> {
    const row = await this.scoped.findByPkOrFail(PortalApprovalRequest, id);
    const context = await this.contextFor([row]);
    const rowContext = context(row);

    const request = toApprovalDto(row, actor, rowContext, new Date());
    const diff = buildApprovalDiff(row.payload, diffSubjectOf(rowContext.campaign));
    return toApprovalDetailDto(request, diff);
  }

  // --- the three decisions -------------------------------------------------------------------

  /** `POST /approvals/:id/approve` (TC-5, TC-6, TC-12, TC-13, TC-15, TC-21, TC-23). */
  async approve(
    actor: AuthenticatedUser,
    id: number,
    comment: string | undefined,
  ): Promise<ApprovalRequest> {
    return this.decide(actor, id, APPROVAL_DECISION.APPROVE, comment ?? null);
  }

  /** `POST /approvals/:id/reject` — terminal for this submission (TC-7, TC-22). */
  async reject(actor: AuthenticatedUser, id: number, comment: string): Promise<ApprovalRequest> {
    return this.decide(actor, id, APPROVAL_DECISION.REJECT, comment);
  }

  /** `POST /approvals/:id/return` — back to the maker for rework (TC-9). */
  async returnForRework(
    actor: AuthenticatedUser,
    id: number,
    comment: string,
  ): Promise<ApprovalRequest> {
    return this.decide(actor, id, APPROVAL_DECISION.RETURN, comment);
  }

  /**
   * The one code path all three decisions take. See this file's header for the ordering and why
   * each step is where it is.
   */
  private async decide(
    actor: AuthenticatedUser,
    id: number,
    decision: ApprovalDecision,
    comment: string | null,
  ): Promise<ApprovalRequest> {
    // Layer 2 (see the header). Independent of `role_entity_permissions`, so TC-17/TC-18 hold
    // even if that table is edited to say otherwise.
    assertRole(actor, 'checker');

    const shape = DECISIONS[decision];
    const trimmed = comment === null ? null : comment.trim();

    const outcome = await this.sequelize.transaction(async (transaction) => {
      // 1. Lock the request row. `findOneOrFail` (not `findByPk`) so the scope clause survives —
      //    `findByPk` in Sequelize replaces `options.where` outright, which is why
      //    `ScopedRepository` routes it through `findOne` in the first place.
      const row = await this.scoped.findOneOrFail(PortalApprovalRequest, {
        where: { id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      // 2. Segregation of duty, before anything else. TC-6: "nothing changed" — nothing has been
      //    written at this point, and the throw rolls back the (read-only) transaction anyway.
      if (row.requestedBy === actor.userId) {
        throw new SelfApprovalForbiddenError(row.id, actor.userId);
      }

      // 3. Refusals, cheapest and most specific first.
      if (row.entityType !== APPROVAL_ENTITY_CAMPAIGN) {
        throw new ApprovalSubjectUnsupportedError(row.entityType);
      }
      if (row.status !== APPROVAL_STATUS.PENDING) {
        throw new ApprovalAlreadyDecidedError(row.id, row.status);
      }
      // Expiry is evaluated from the row itself, not from the stored `status`, so a request whose
      // deadline passed before the sweeper ran is still refused (implementation note 5, TC-13).
      if (isApprovalExpired({ status: row.status, expiresAt: row.expiresAt })) {
        throw new ApprovalExpiredError(row.id, row.expiresAt);
      }

      // 4. The guarded write. `status: 'pending'` in the WHERE is the second, independent proof
      //    that nobody decided this between the lock and here.
      const affected = await this.scoped.update(
        PortalApprovalRequest,
        {
          status: shape.requestStatus,
          reviewedBy: actor.userId,
          reviewedAt: new Date(),
          reviewComment: trimmed,
        },
        { where: { id, status: APPROVAL_STATUS.PENDING }, transaction },
      );
      if (affected === 0) throw new ApprovalAlreadyDecidedError(row.id, row.status);

      // 5. The campaign. `entity_id` is nullable on this table, so a row that names no campaign
      //    is refused rather than silently decided into nothing.
      if (row.entityId === null) throw new ApprovalSubjectUnsupportedError(row.entityType);
      const campaign = await this.scoped.findByPkOrFail(TenantCampaign, row.entityId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const nextStatus = assertTransition(campaign.status, shape.transition);

      await this.scoped.update(
        TenantCampaign,
        decision === APPROVAL_DECISION.APPROVE
          ? {
              status: nextStatus,
              // gap G5 / `actor-ref.ts` — `approved_by` is `varchar(100)`, so the id as a string.
              approvedBy: actorRefText(actor),
              approvedAt: new Date(),
            }
          : { status: nextStatus },
        { where: { id: campaign.id }, transaction },
      );

      // 6. Audit. `recordOrFail` — see this file's header.
      await this.audit.recordOrFail(
        actor,
        {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          entityType: AUDIT_ENTITY.APPROVAL,
          entityId: campaign.id,
          action: shape.auditAction,
          approvalRequestId: row.id,
          comment: trimmed,
          fieldChanges: { decision, from: campaign.status, to: nextStatus },
        },
        transaction,
      );

      // Sequentially, not `Promise.all`: both reads run on the transaction's single connection,
      // and issuing two statements concurrently down one connection is a hazard with no upside
      // here — the two rows are tiny and already locked.
      const decided = await this.scoped.findByPkOrFail(PortalApprovalRequest, id, { transaction });
      const reloadedCampaign = await this.scoped.findByPkOrFail(TenantCampaign, campaign.id, {
        transaction,
      });

      return { request: decided, campaign: reloadedCampaign, makerId: row.requestedBy };
    });

    await this.notifyMaker(outcome, shape, trimmed);

    // T-047 / 09-INTEGRATION.md §9. **Only** after governance completes, and only for the decision
    // that makes a campaign live: a rejection and a return both land the campaign back on `draft`,
    // which the runtime has never been told about and must not be (*"NO EVENT (not yet real)"*).
    // Published outside the transaction, after the commit and the notification, so an event can
    // never announce a state the database did not reach.
    if (outcome.campaign.status === CAMPAIGN_STATUS.ACTIVE) {
      this.changeEvents.publishTransition({
        campaignId: outcome.campaign.id,
        campaignCode: outcome.campaign.campaignCode,
        tenantId: outcome.campaign.tenantId,
        changeType: 'UPDATED',
      });
    }

    const context = await this.contextFor([outcome.request]);
    return toApprovalDto(outcome.request, actor, context(outcome.request), new Date());
  }

  // --- private ---------------------------------------------------------------------------------

  /**
   * Resolves the display names and campaign subjects one page needs, in **two** queries rather
   * than two per row.
   *
   * Returns a lookup function rather than a map of maps, so the call site reads as
   * `context(row)` and cannot accidentally pair one row's id with another's name.
   */
  private async contextFor(
    rows: readonly PortalApprovalRequest[],
  ): Promise<(row: PortalApprovalRequest) => ApprovalRowContext> {
    if (rows.length === 0) {
      return () => ({ requesterName: null, reviewerName: null, campaign: null });
    }

    const userIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.reviewedBy === null ? [row.requestedBy] : [row.requestedBy, row.reviewedBy],
        ),
      ),
    ].slice(0, MAX_NAME_LOOKUPS);

    const campaignIds = [
      ...new Set(
        rows
          .filter((row) => row.entityType === APPROVAL_ENTITY_CAMPAIGN && row.entityId !== null)
          .map((row) => row.entityId as number),
      ),
    ];

    const [users, campaigns] = await Promise.all([
      userIds.length === 0
        ? Promise.resolve([])
        : this.scoped.listAll(PortalUser, {
            where: { id: { [Op.in]: userIds } },
            attributes: ['id', 'displayName'],
          }),
      campaignIds.length === 0
        ? Promise.resolve([])
        : this.scoped.listAll(TenantCampaign, { where: { id: { [Op.in]: campaignIds } } }),
    ]);

    const nameById = new Map(users.map((user) => [user.id, user.displayName]));
    const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));

    return (row) => ({
      requesterName: nameById.get(row.requestedBy) ?? null,
      reviewerName: row.reviewedBy === null ? null : (nameById.get(row.reviewedBy) ?? null),
      campaign:
        row.entityType === APPROVAL_ENTITY_CAMPAIGN && row.entityId !== null
          ? (campaignById.get(row.entityId) ?? null)
          : null,
    });
  }

  /**
   * Implementation note 3's *"notify the maker"* (TC-21, TC-22).
   *
   * Outside the decision transaction, and `notify()` never rejects anyway (T-040's contract): a
   * checker's decision must not fail because a notification could not be written. The maker's
   * queue is driven by the campaign's own status, not by this row, so a lost notification costs
   * a nudge rather than the workflow.
   */
  private async notifyMaker(
    outcome: DecisionOutcome,
    shape: DecisionShape,
    comment: string | null,
  ): Promise<void> {
    const campaign = outcome.campaign;
    const reason = comment === null || comment === '' ? '' : ` Comment: ${comment}`;
    await this.notifications.notify({
      tenantId: campaign.tenantId,
      recipientPortalUserId: outcome.makerId,
      notificationType: shape.notificationType,
      title: shape.notificationTitle,
      message: `"${campaign.name}" was ${pastTense(shape.notificationType)} by a checker.${reason}`,
      entityType: 'campaign',
      entityId: campaign.id,
      entityLabel: campaign.campaignCode,
    });
  }
}

// --- module-private helpers ---------------------------------------------------------------------

/**
 * The whitelisted filters of `GET /approvals` — explicit parameters only, never a query DSL from
 * the client (03-API-CONTRACT.md §1).
 */
function buildWhere(query: ListApprovalsQueryDto): WhereOptions | undefined {
  const clauses: WhereOptions[] = [];
  if (query.status !== undefined) clauses.push({ status: query.status } as WhereOptions);
  if (query.entityType !== undefined) {
    clauses.push({ entityType: query.entityType } as WhereOptions);
  }
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { [Op.and]: clauses } as WhereOptions;
}

/** The campaign reduced to the four scalars the diff compares. `null` stays `null` — the diff
 * reports that as `SUBJECT_UNAVAILABLE` rather than throwing (TC-20). */
function diffSubjectOf(campaign: TenantCampaign | null): DiffSubject | null {
  if (campaign === null) return null;
  return {
    campaignCode: campaign.campaignCode,
    name: campaign.name,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
  };
}

/** The verb for the notification body. Derived from the notification type rather than from the
 * decision key, so the copy and the type can never disagree about which event happened. */
function pastTense(notificationType: string): string {
  if (notificationType === NOTIFICATION_TYPE.CAMPAIGN_APPROVED) return 'approved';
  if (notificationType === NOTIFICATION_TYPE.CAMPAIGN_REJECTED) return 'rejected';
  return 'returned for rework';
}
