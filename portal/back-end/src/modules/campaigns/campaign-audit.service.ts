/**
 * T-037 — the campaign audit trail, written for real.
 *
 * ### Why this is not simply `AuditService.recordDomainEvent`
 *
 * It would be, and it was the first thing tried. `common/audit/audit.service.ts` already has the
 * method, and its own header explains why calling it from here would write nothing:
 *
 * > *"`campaign_audit_trail.performed_by` carries `fk_cat_performed_by →
 * > reward_config.admin_users(id)` … When no link exists, the row is **skipped** rather than
 * > attempted … **This is a live design gap** — the `maker` and `checker` roles, which are
 * > precisely the roles that create and approve campaigns, cannot be represented in `admin_users`
 * > at all (gap G1), so unless Wave 3 provides `performedBy` explicitly they will produce no
 * > domain audit rows. Escalated in the T-014 completion report."*
 *
 * T-037 is the Wave 3 task that came due against that sentence, and there is no `performedBy` it
 * could provide: `ck_admin_users_role` permits four roles and `maker` is not among them, so the
 * row a maker would need does not exist and cannot be created. Verified live before this file
 * was written — `admin_users` holds 2 rows and `portal_users.admin_user_id` is populated for 0.
 *
 * So this service writes `reward_portal.portal_campaign_audit_trail` (T037_002) instead — the
 * same table shape with a real `portal_users` foreign key, which is the resolution the architect
 * already accepted for the identical gap in T-040. See that migration's header for the full
 * argument and for the one disclosed consequence (`GET /audit/campaigns` still reads the old
 * table).
 *
 * ### An audit failure must never fail the request
 *
 * T-014 implementation note 4, adopted here verbatim rather than reinvented: every method
 * returns `Promise<void>` and **cannot reject**. A failed write is logged at `error` with the
 * whole event, so the record still exists somewhere an operator can find it and the log doubles
 * as the recovery source. An audit outage that takes campaign creation down is a worse outcome
 * than a gap in the table — but the gap must be loud.
 *
 * The one thing that is *not* best-effort is the audit row for **submission**, which is written
 * inside `submit`'s transaction (see `campaigns.service.ts`) rather than through this service.
 * A campaign that reached `pending_approval` with no trace of who sent it there is a governance
 * failure, not an inconvenience.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { redactForLog } from '@/common/logging/redact';
import { PortalCampaignAuditTrail } from '@/database/portal-models';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { actorRefId } from './actor-ref';
import { AUDIT_ACTION, AUDIT_ENTITY } from './campaigns.constants';

type AuditEntity = (typeof AUDIT_ENTITY)[keyof typeof AUDIT_ENTITY];
type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

export interface CampaignAuditEvent {
  readonly tenantId: number;
  readonly campaignId: number;
  readonly entityType: AuditEntity;
  readonly action: AuditAction;
  readonly entityId?: number | null;
  readonly fieldChanges?: Record<string, unknown> | null;
  readonly comment?: string | null;
  readonly approvalRequestId?: number | null;
}

@Injectable()
export class CampaignAuditService {
  private readonly logger = new Logger(CampaignAuditService.name);

  constructor(private readonly scoped: ScopedRepository) {}

  /**
   * Appends one row. Never rejects — see this file's header.
   *
   * `transaction` is optional and is passed by the callers that genuinely need the audit row to
   * live or die with the change it describes (submission). For an ordinary edit it is omitted,
   * so a slow audit write cannot hold a row lock open across the rest of a request.
   */
  async record(
    actor: AuthenticatedUser,
    event: CampaignAuditEvent,
    transaction?: Transaction,
  ): Promise<void> {
    try {
      await this.write(actor, event, transaction);
    } catch (error) {
      this.logger.error(
        'AUDIT WRITE FAILED (portal_campaign_audit_trail) — the request was not affected. ' +
          `Event: ${JSON.stringify(redactForLog(event))}. Cause: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  /**
   * {@link record}, but propagating a failure.
   *
   * Used only inside `submit`'s transaction. There, a swallowed error would commit a campaign
   * into `pending_approval` with no record of who submitted it — the one case where losing the
   * audit row is worse than losing the operation, because the operation is a governance event
   * whose whole value is that it was recorded.
   */
  async recordOrFail(
    actor: AuthenticatedUser,
    event: CampaignAuditEvent,
    transaction: Transaction,
  ): Promise<void> {
    await this.write(actor, event, transaction);
  }

  private async write(
    actor: AuthenticatedUser,
    event: CampaignAuditEvent,
    transaction?: Transaction,
  ): Promise<void> {
    await this.scoped.create(
      PortalCampaignAuditTrail,
      {
        // Supplied explicitly *and* forced from scope by `ScopedRepository` for every non-super
        // -admin role — the two agree by construction, and the explicit value is what makes the
        // insert valid for a `super_admin`, whose scope forces nothing.
        tenantId: event.tenantId,
        campaignId: event.campaignId,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        action: event.action,
        fieldChanges: event.fieldChanges ?? null,
        performedBy: actorRefId(actor),
        performedAt: new Date(),
        approvalRequestId: event.approvalRequestId ?? null,
        comment: event.comment ?? null,
        // `retention_expires_at` is deliberately **not** set: it has a seven-year database
        // default (08-OBSERVABILITY.md §7), and retention policy belongs to the schema rather
        // than to a caller that could quietly shorten it. See the model's own comment on that
        // attribute for why it is declared `allowNull: true` to make this omission possible.
      } as never,
      { transaction },
    );
  }

  /**
   * The before/after diff of **changed fields only**.
   *
   * Same three rules `AuditService.diffFields` states — only what changed, structural
   * comparison, no sensitive keys — reimplemented here on the narrow shape this module produces
   * rather than imported, because `AuditService` is injected only by modules that also write
   * `portal_audit_log` and this module does not. Kept deliberately small: if it ever needs to
   * grow, importing T-014's is the right move.
   */
  diff(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Record<string, { before: unknown; after: unknown }> {
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const from = stable(before[key]);
      const to = stable(after[key]);
      if (from === to) continue;
      changes[key] = { before: before[key] ?? null, after: after[key] ?? null };
    }
    return changes;
  }
}

/** Value equality for the diff. Never throws — a `Date` and a cyclic object both compare
 * sensibly rather than crashing an audit write. */
function stable(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return `[UNCOMPARABLE:${String(Math.random())}]`;
  }
}
