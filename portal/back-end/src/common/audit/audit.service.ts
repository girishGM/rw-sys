/**
 * T-014 — everything that decides *what* an audit row contains, and the promise that writing one
 * can never break a request.
 *
 * ### The two rules that shape this file
 *
 * **1. An audit failure must not fail the request** (implementation note 4):
 *
 * > *"Wrap in try/catch, log the failure at `error`, and continue. An audit outage that takes
 * > the portal down is a worse outcome than a gap in the log — but the failure must be loudly
 * > visible."*
 *
 * Every public method here returns `Promise<void>` and **cannot reject**. The "loudly visible"
 * half is taken literally: when an insert fails, the whole event — redacted — is written to the
 * error log, so the record still exists somewhere an operator can find it, and the log doubles
 * as the recovery source for a gap in the table (TC-7).
 *
 * **2. Nothing sensitive reaches a row.** Two independent mechanisms, because one is not enough:
 *
 *  - *Structural*: `recordRequestFailure` — the path that audits failed logins — never reads the
 *    request **body**. Not "reads it and redacts it": never reads it. The detail object is built
 *    from the method, the route, the status and the response code, so there is no code path down
 *    which a submitted password could travel, redaction bug or not (TC-2).
 *  - *Filtering*: everything else passes through `redact()` before insert, and `diffFields`
 *    drops redaction-listed keys entirely rather than masking them, because a `field_changes`
 *    entry saying `password_hash: { before: '[REDACTED]', after: '[REDACTED]' }` is noise that
 *    tells an investigator nothing and tells a future reader that hashes belong in this column
 *    (implementation note 3).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedRequest } from '@/modules/auth/decorators/current-user.decorator';
import { isSensitiveKey, redact, redactForLog } from '@/common/logging/redact';
import { AuditContext, type AuditDraft } from './audit-context';
import {
  AUDIT_COMMENT_COLUMN_LIMIT,
  AUDIT_EVENT_COLUMN_LIMIT,
  AUDIT_TARGET_COLUMN_LIMIT,
  FAILURE_EVENT_BY_CODE,
  type CampaignAuditAction,
  type CampaignAuditEntityType,
} from './audit.constants';
import { AUDIT_STORE, type AuditStore } from './audit.repository';

/** An auth / access-control / admin event, before redaction and truncation. */
export interface PortalAuditEventInput {
  readonly eventType: string;
  readonly actorId?: number | null;
  readonly actorRole?: string | null;
  readonly targetType?: string | null;
  readonly targetId?: string | number | null;
  readonly countryId?: number | null;
  readonly tenantId?: number | null;
  readonly ipAddress?: string | null;
  readonly detail?: Record<string, unknown> | null;
}

/** A campaign / domain change. */
export interface DomainAuditEventInput {
  readonly tenantId: number;
  readonly campaignId: number;
  readonly entityType: CampaignAuditEntityType;
  readonly action: CampaignAuditAction;
  readonly entityId?: number | null;
  readonly fieldChanges?: Record<string, unknown> | null;
  /** A `reward_config.admin_users` id. Resolved from {@link actorPortalUserId} when absent. */
  readonly performedBy?: number;
  /** The portal user who acted; used only to resolve `performedBy`. */
  readonly actorPortalUserId?: number;
  readonly approvalRequestId?: number | null;
  readonly comment?: string | null;
}

/** What `ErrorNormalizationFilter` hands over for every failed request. */
export interface RequestFailureInput {
  readonly request: Request;
  readonly status: number;
  readonly code: string;
  readonly traceId: string;
}

/** One `field_changes` entry. Only fields that actually changed appear. */
export interface FieldChange {
  readonly before: unknown;
  readonly after: unknown;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(AUDIT_STORE) private readonly store: AuditStore) {}

  // --- writes ------------------------------------------------------------------------------

  /**
   * Appends a row to `reward_portal.portal_audit_log`. Never rejects.
   *
   * `detail` is redacted; `event_type`, `target_type` and `target_id` are truncated to the
   * column widths rather than allowed to fail the insert — losing the tail of a target id is
   * strictly better than losing the whole event, and these columns are `varchar(60)`.
   */
  async recordPortalEvent(event: PortalAuditEventInput): Promise<void> {
    await this.safely('portal_audit_log', event, () =>
      this.store.insertPortalEvent({
        eventType: clamp(event.eventType, AUDIT_EVENT_COLUMN_LIMIT),
        actorId: event.actorId ?? null,
        actorRole: event.actorRole ?? null,
        targetType: truncate(event.targetType, AUDIT_TARGET_COLUMN_LIMIT),
        targetId: truncate(stringifyId(event.targetId), AUDIT_TARGET_COLUMN_LIMIT),
        countryId: event.countryId ?? null,
        tenantId: event.tenantId ?? null,
        ipAddress: event.ipAddress ?? null,
        detail: redactDetail(event.detail),
      }),
    );
  }

  /**
   * Appends a row to `reward_config.campaign_audit_trail`. Never rejects.
   *
   * ### `performed_by` and the `admin_users` foreign key
   *
   * The column carries `fk_cat_performed_by → reward_config.admin_users(id)`, while the portal's
   * identity table is `reward_portal.portal_users`. The two id spaces are unrelated, so the
   * portal user id **must not** be written here: it would either violate the constraint or, far
   * worse, silently attribute the action to whichever unrelated `admin_users` row happens to
   * share the number. `portal_users.admin_user_id` (01-DATABASE.md §2.1) is the sanctioned link
   * and is resolved here when the caller does not supply `performedBy` directly.
   *
   * When no link exists, the row is **skipped** rather than attempted: an insert that is certain
   * to violate a foreign key is not a write, it is a log line with extra steps. The skip is
   * logged at `error` with the full event, per note 4. **This is a live design gap** — the
   * `maker` and `checker` roles, which are precisely the roles that create and approve
   * campaigns, cannot be represented in `admin_users` at all (00-ARCHITECTURE.md §5.2 gap G1),
   * so unless Wave 3 provides `performedBy` explicitly they will produce no domain audit rows.
   * Escalated in the T-014 completion report; not silently redesigned here (AGENT-PROTOCOL §3).
   */
  async recordDomainEvent(event: DomainAuditEventInput): Promise<void> {
    await this.safely('campaign_audit_trail', event, async () => {
      const performedBy = await this.resolvePerformedBy(event);
      if (performedBy === null) {
        throw new Error(
          `No reward_config.admin_users link for portal user ${String(event.actorPortalUserId)} ` +
            '— campaign_audit_trail row skipped (fk_cat_performed_by would fail). ' +
            'Pass performedBy explicitly, or link the account via portal_users.admin_user_id.',
        );
      }

      await this.store.insertDomainEvent({
        tenantId: event.tenantId,
        campaignId: event.campaignId,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        action: event.action,
        fieldChanges: redactDetail(event.fieldChanges),
        performedBy,
        approvalRequestId: event.approvalRequestId ?? null,
        comment: truncate(event.comment, AUDIT_COMMENT_COLUMN_LIMIT),
      });
    });
  }

  /**
   * Records the security-relevant failures of a request, for `ErrorNormalizationFilter`.
   *
   * Only the codes in {@link FAILURE_EVENT_BY_CODE} produce a row — a 404 on a public page or a
   * mistyped form is not a security event, and an audit log full of those is one nobody reads.
   *
   * **The request body is never touched.** `detail` is assembled from the method, the
   * parameterised route, the status, the code and the trace id. That is what makes TC-2 ("`detail`
   * contains **no** password") a property of the code's shape rather than of a redaction pass —
   * and it is why the audited `login_failure` row deliberately carries no email either. The
   * submitted address is already recorded, with its own failure code, in
   * `portal_login_attempts` by T-010.
   */
  async recordRequestFailure(input: RequestFailureInput): Promise<void> {
    const eventType = FAILURE_EVENT_BY_CODE[input.code];
    if (eventType === undefined) return;

    const request = input.request as AuthenticatedRequest;
    const actor = request.authUser;
    const route = routePath(request);

    await this.recordPortalEvent({
      eventType,
      actorId: actor?.userId ?? null,
      actorRole: actor?.role ?? null,
      // The attempted target: the parameterised route and the HTTP method. The RBAC
      // `entity:action` pair the guard checked is deliberately *not* available here — Nest builds
      // an exception filter's `ArgumentsHost` with no handler reference (`RouterProxy.createProxy`
      // constructs `new ExecutionContextHost([req, res, next])`), so route metadata cannot be
      // read from a filter. See the T-014 completion report.
      targetType: 'route',
      targetId: route,
      countryId: actor?.countryId ?? null,
      tenantId: actor?.tenantId ?? null,
      ipAddress: ipOf(request),
      detail: {
        method: request.method,
        route,
        status: input.status,
        code: input.code,
        traceId: input.traceId,
      },
    });
  }

  // --- annotation, for handlers and services -----------------------------------------------

  /**
   * Contributes data to the audit row for the current request — the target id, the diff, the
   * campaign the change belongs to.
   *
   * A no-op outside an audited handler, logged at `debug`: a service annotating into the void
   * usually means a missing `@Audit()` decorator, and silence is how that ships.
   */
  annotate(patch: AuditDraft): void {
    if (!AuditContext.annotate(patch)) {
      this.logger.debug(
        'audit.annotate() called outside an audited handler — nothing recorded. ' +
          'Is @Audit() missing from the route?',
      );
    }
  }

  // --- helpers a caller uses to build a diff ------------------------------------------------

  /**
   * The before/after diff of **changed fields only** (implementation note 3).
   *
   * Three rules, each of which exists because the obvious implementation gets it wrong:
   *
   *  - **Only what changed.** Storing the whole entity turns the trail into a copy of the table
   *    and makes "what did this person actually do?" unanswerable at a glance.
   *  - **Redaction-listed keys are dropped, not masked.** A `field_changes` of
   *    `{ password_hash: { before: '[REDACTED]', after: '[REDACTED]' } }` records nothing except
   *    the suggestion that hashes belong in an audit column.
   *  - **Comparison is structural.** `JSON.stringify` of each side, so a `jsonb` column or a
   *    `Date` compares by value rather than by reference (`new Date(x) !== new Date(x)` would
   *    otherwise report every timestamp as changed on every update).
   */
  diffFields(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Record<string, FieldChange> {
    const changes: Record<string, FieldChange> = {};

    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (isSensitiveKey(key)) continue;
      const from = before[key];
      const to = after[key];
      if (stableString(from) === stableString(to)) continue;
      changes[key] = { before: from ?? null, after: to ?? null };
    }

    return changes;
  }

  // --- internals ---------------------------------------------------------------------------

  private async resolvePerformedBy(event: DomainAuditEventInput): Promise<number | null> {
    if (event.performedBy !== undefined) return event.performedBy;
    if (event.actorPortalUserId === undefined) return null;
    return this.store.findAdminUserId(event.actorPortalUserId);
  }

  /**
   * The never-fail wrapper. Implementation note 4 in one place, so no caller has to remember it.
   *
   * The failed event is logged **redacted and in full**, which is the difference between a gap
   * in the audit table and a lost event: an operator replaying the error log can reconstruct
   * every row the database refused.
   */
  private async safely(table: string, event: object, write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.logger.error(
        `AUDIT WRITE FAILED (${table}) — the request was not affected. ` +
          `Event: ${JSON.stringify(redactForLog(event))}. Cause: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}

// --- module-private helpers ------------------------------------------------------------------

/** `redact()` narrowed back to the row shape. Returns `null` for an absent or empty detail. */
function redactDetail(detail: Record<string, unknown> | null | undefined) {
  if (detail === null || detail === undefined) return null;
  return redact(detail) as Record<string, unknown>;
}

function stringifyId(id: string | number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  return String(id);
}

function truncate(value: string | null | undefined, limit: number): string | null {
  if (value === null || value === undefined) return null;
  return clamp(value, limit);
}

/** {@link truncate} for a column that is `NOT NULL`, so the result is never null either. */
function clamp(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

/**
 * The parameterised route (`/campaigns/:id/submit`), not the concrete URL.
 *
 * 08-OBSERVABILITY.md §3: *"`http.route` is the parameterised route … `/campaigns/8821/submit`
 * fragments aggregation into thousands of buckets **and can itself carry identifiers**."* The
 * second half is the security-relevant one — a concrete path can contain an email or a token in
 * a query string, and this value is written to a table.
 */
function routePath(request: Request): string {
  const route = (request as { route?: { path?: unknown } }).route;
  if (typeof route?.path === 'string') return route.path;
  return typeof request.path === 'string' ? request.path : '';
}

/**
 * The caller's IP, or null. Cast to `inet` by the repository, so a malformed value would fail
 * the insert — Express produces either a valid address or `undefined`.
 */
function ipOf(request: Request): string | null {
  return typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null;
}

/**
 * Value equality for the diff. Never throws.
 *
 * `value ?? null` first, so `undefined` (an absent field on one side) becomes `"null"` rather
 * than `JSON.stringify`'s `undefined` — which would make the return type a lie and every
 * added-or-removed field compare equal to every other one.
 */
function stableString(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    // A cycle or a throwing `toJSON`: treat as always-changed rather than crashing a diff.
    return `[UNCOMPARABLE:${Math.random()}]`;
  }
}
