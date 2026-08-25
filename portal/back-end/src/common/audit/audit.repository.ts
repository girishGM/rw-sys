/**
 * T-014 — the two audit `INSERT`s, and nothing else.
 *
 * Split from `AuditService` (which owns redaction, diffing and the never-fail policy) so that
 * policy can be unit-tested against a fake store, and so that the exact SQL that reaches the
 * database is readable in one short file. Same arrangement, for the same reasons, as T-011's
 * `SessionRepository` and this task's `SystemMessageRepository`.
 *
 * ### Append-only, at three levels
 *
 * There is no `update`, no `delete` and no `find` here. `reward_app` holds `SELECT, INSERT` and
 * nothing more on both tables — `REVOKE UPDATE, DELETE` (01-DATABASE.md §3, applied by
 * T002_008) — so an attempt would fail at the database anyway (TC-5). The absence of the method
 * is the first level, the grant is the second, and the models' own doc comments are the third.
 *
 * ### Why raw SQL rather than `ScopedRepository` (AGENT-PROTOCOL R2)
 *
 * R2 guarantees that *tenant data* is never read or written without the tenant predicate in the
 * WHERE clause. These are inserts of rows whose scope columns are taken from the **verified
 * JWT** by `AuditService` — there is no WHERE clause to scope and no client-supplied value in
 * sight. More decisively: an audit row must be writable in situations where no scope context
 * exists at all — a failed login has no actor, and a rejected refresh token never reaches an
 * interceptor — and `ScopedRepository` is deliberately built to throw there. T-011 reached the
 * same conclusion and writes `portal_audit_log` the same way (`session.repository.ts`).
 *
 * Every value is bound through `replacements`; no fragment of any statement below is built from
 * a request.
 */
import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { TraceContext } from '@/common/tracing/trace-context';
import type { CampaignAuditAction, CampaignAuditEntityType } from './audit.constants';

/** A row of `reward_portal.portal_audit_log`, already redacted and truncated by the service. */
export interface PortalAuditRow {
  readonly eventType: string;
  readonly actorId: number | null;
  readonly actorRole: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly countryId: number | null;
  readonly tenantId: number | null;
  readonly ipAddress: string | null;
  readonly detail: Record<string, unknown> | null;
}

/** A row of `reward_config.campaign_audit_trail`. `performed_at`/`retention_expires_at` default. */
export interface DomainAuditRow {
  readonly tenantId: number;
  readonly campaignId: number;
  readonly entityType: CampaignAuditEntityType;
  readonly entityId: number | null;
  readonly action: CampaignAuditAction;
  readonly fieldChanges: Record<string, unknown> | null;
  readonly performedBy: number;
  readonly approvalRequestId: number | null;
  readonly comment: string | null;
}

/** What `AuditService` depends on. Implemented below; faked in unit tests. */
export interface AuditStore {
  insertPortalEvent(row: PortalAuditRow): Promise<void>;
  insertDomainEvent(row: DomainAuditRow): Promise<void>;
  /** `portal_users.admin_user_id` for a portal user, or `null` when the accounts are not linked. */
  findAdminUserId(portalUserId: number): Promise<number | null>;
}

/** DI token — consumers depend on {@link AuditStore}, never on the class. */
export const AUDIT_STORE = Symbol('AUDIT_STORE');

@Injectable()
export class AuditRepository implements AuditStore {
  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  async insertPortalEvent(row: PortalAuditRow): Promise<void> {
    await this.sequelize.query(
      `
      INSERT INTO reward_portal.portal_audit_log
             (event_type, actor_id, actor_role, target_type, target_id,
              country_id, tenant_id, ip_address, detail, correlation_id, occurred_at)
      VALUES (:eventType, :actorId, :actorRole, :targetType, :targetId,
              :countryId, :tenantId, CAST(:ipAddress AS inet), CAST(:detail AS jsonb),
              :correlationId, now())
      `,
      {
        type: QueryTypes.INSERT,
        replacements: {
          eventType: row.eventType,
          actorId: row.actorId,
          actorRole: row.actorRole,
          targetType: row.targetType,
          targetId: row.targetId,
          countryId: row.countryId,
          tenantId: row.tenantId,
          ipAddress: row.ipAddress,
          detail: row.detail === null ? null : JSON.stringify(row.detail),
          // T-019, and taken from the ambient trace rather than from `PortalAuditRow`
          // deliberately. 08-OBSERVABILITY.md §2 requires the id on *every* audit row, and a
          // parameter on the row interface is a parameter some future caller forgets — which
          // would produce exactly the untraceable audit entry the requirement exists to prevent.
          // Reading it here means no caller can omit it and no caller can forge it. `null`
          // outside a request (a CLI bootstrap, a rejected refresh token), which the column
          // accepts — see `T019_001_audit_correlation_id.ts`.
          correlationId: TraceContext.correlationId(),
        },
      },
    );
  }

  /**
   * `field_changes` is `text` holding JSON on this table, not `jsonb` — the column predates the
   * portal and 01-DATABASE.md leaves it alone (R1: no DDL against `reward_config`). It is
   * stringified here for the same reason `campaign-audit-trail.model.ts` has a getter/setter
   * pair: the shape callers work with is an object, and exactly one place converts.
   */
  async insertDomainEvent(row: DomainAuditRow): Promise<void> {
    await this.sequelize.query(
      `
      INSERT INTO reward_config.campaign_audit_trail
             (tenant_id, campaign_id, entity_type, entity_id, action, field_changes,
              performed_by, performed_at, approval_request_id, comment)
      VALUES (:tenantId, :campaignId, :entityType, :entityId, :action, :fieldChanges,
              :performedBy, now(), :approvalRequestId, :comment)
      `,
      {
        type: QueryTypes.INSERT,
        replacements: {
          tenantId: row.tenantId,
          campaignId: row.campaignId,
          entityType: row.entityType,
          entityId: row.entityId,
          action: row.action,
          fieldChanges: serialiseFieldChanges(row.fieldChanges),
          performedBy: row.performedBy,
          approvalRequestId: row.approvalRequestId,
          comment: row.comment,
        },
      },
    );
  }

  /**
   * The portal→`admin_users` link (`portal_users.admin_user_id`, 01-DATABASE.md §2.1: *"optional
   * link to reward_config.admin_users"*).
   *
   * It is needed because `campaign_audit_trail.performed_by` carries a foreign key to
   * `admin_users` while the portal's own identity table is `reward_portal.portal_users` — the
   * two id spaces are unrelated. See `audit.service.ts` for what happens when the link is null,
   * and the T-014 completion report for why that case is a design escalation rather than a bug.
   */
  async findAdminUserId(portalUserId: number): Promise<number | null> {
    const rows = await this.sequelize.query<{ admin_user_id: number | null }>(
      'SELECT admin_user_id FROM reward_portal.portal_users WHERE id = :portalUserId',
      { type: QueryTypes.SELECT, replacements: { portalUserId } },
    );
    return rows[0]?.admin_user_id ?? null;
  }
}

/**
 * The reserved `field_changes` key that carries the correlation id into
 * `reward_config.campaign_audit_trail` (T-019).
 *
 * ### Why it is a JSON key and not a column
 *
 * 08-OBSERVABILITY.md §2 requires the id to reach *"every domain audit row"*, and §6's
 * trace-retrieval endpoint (T-045) assembles its narrative from every store *"keyed by
 * `correlation_id`"*. `campaign_audit_trail` has no such column — verified against the extracted
 * DDL — and **AGENT-PROTOCOL R1 forbids adding one**: no DDL against `reward_config` beyond
 * T-002's two `DROP NOT NULL`s. AGENT-PROTOCOL §7 names this case exactly ("a required column
 * does not exist in `reward_config`: do not create it"), so it is escalated in the T-019
 * completion report and carried in the table's existing free-form JSON column meanwhile.
 *
 * It is queryable — `field_changes::jsonb ->> '__correlationId' = :cid` — though unindexed, which
 * is the honest cost of not owning the table. The double underscore marks it as an envelope key
 * rather than a changed field, so a reader of a diff can tell at a glance that no column called
 * `__correlationId` was edited.
 */
export const DOMAIN_CORRELATION_KEY = '__correlationId';

/**
 * `field_changes` as the `text` column wants it: JSON, or `null`.
 *
 * A row written inside a request always gets the envelope key, **even when there is no diff** —
 * an `action: 'submitted'` row has nothing to diff and is precisely the kind of event an
 * investigation starts from, so `null` there would lose the one row that matters most.
 */
function serialiseFieldChanges(fieldChanges: Record<string, unknown> | null): string | null {
  const correlationId = TraceContext.correlationId();
  if (correlationId === null) {
    return fieldChanges === null ? null : JSON.stringify(fieldChanges);
  }
  return JSON.stringify({ ...fieldChanges, [DOMAIN_CORRELATION_KEY]: correlationId });
}
