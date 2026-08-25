/**
 * T-014 — the per-request audit draft, the channel by which a service tells the interceptor
 * *what* it changed.
 *
 * ### The problem this solves
 *
 * `@Audit({ event, targetType })` is on the **handler**, where the route is known but the data
 * is not: the interceptor cannot know which campaign was updated, which fields changed, or what
 * their previous values were. The service knows all three and nothing else does.
 *
 * Threading an audit object through every service signature would work and would be forgotten
 * within a week. So the same mechanism T-013 uses for the tenancy scope is used here, for the
 * same reason (`scope-context.ts`: *"nothing is injected, nothing is re-instantiated, and the
 * failure mode of forgetting to establish the context is a loud one"*): an `AsyncLocalStorage`
 * holding a mutable draft that `AuditService.annotate()` writes into and the interceptor reads
 * once the handler has succeeded.
 *
 * ### How it differs from `ScopeContext`, and why
 *
 *  - **The store is mutable.** `RequestScope` is frozen because a scope that can change mid-
 *    request is not a constraint; a draft exists precisely to be filled in.
 *  - **Absence is not an error.** `ScopeContext.require` throws, because an unscoped query is a
 *    cross-tenant leak. A service calling `annotate()` outside an audited handler is at worst a
 *    misplaced call, and turning that into a 500 would mean an audit-annotation mistake could
 *    take down a request — the exact inversion implementation note 4 forbids.
 *
 * ### The subscription trap
 *
 * The store must be entered *inside* the observable's subscription, not around the construction
 * of it — see `tenancy-scope.interceptor.ts`, which documents the failure mode in full (a draft
 * belonging to another request under concurrency). `audit.interceptor.ts` uses the same shape.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CampaignAuditAction, CampaignAuditEntityType } from './audit.constants';

/**
 * What a handler or service may contribute to the audit row for the current request.
 *
 * Every field is optional: an audited handler that annotates nothing still produces a row, with
 * the actor, scope, IP and route the interceptor derives on its own.
 */
export interface AuditDraft {
  /** `portal_audit_log.target_id` — the id of the thing acted on. Stringified and truncated. */
  targetId?: string | number | null;
  /** Overrides the decorator's `targetType` when a handler audits more than one kind of thing. */
  targetType?: string;
  /** Merged into `portal_audit_log.detail`. **Redacted** before it is written. */
  detail?: Record<string, unknown>;

  // --- `campaign_audit_trail` only ---------------------------------------------------------
  /** The campaign the change belongs to. Required for a domain event; the row is NOT NULL. */
  campaignId?: number;
  /**
   * The owning tenant, when the actor's own scope does not supply it — a `super_admin` has a
   * `null` `tenantId` in the JWT but can act on any tenant's campaign.
   *
   * This is **not** an AGENT-PROTOCOL R3 exception. The value a service passes here comes from
   * the row it just loaded through `ScopedRepository`, i.e. from the database after the scope
   * predicate has been applied — never from a DTO. R3 forbids trusting a client-supplied scope,
   * not recording the scope of a row the server itself read.
   */
  tenantId?: number;
  /** The specific row that changed, when it is not the campaign itself (a tracker, a cap). */
  entityId?: number | null;
  /** Overrides the decorator's action — e.g. a single handler that both approves and rejects. */
  action?: CampaignAuditAction;
  /** Overrides the decorator's entity type. */
  entityType?: CampaignAuditEntityType;
  /**
   * The before/after diff. Build it with `AuditService.diffFields(before, after)`, which keeps
   * **only changed fields** and drops anything matching the redaction list (implementation
   * note 3) — never assign a whole entity here.
   */
  fieldChanges?: Record<string, unknown>;
  /**
   * `campaign_audit_trail.performed_by` — a `reward_config.admin_users` id, **not** a portal
   * user id (there is a foreign key). Left unset, `AuditService` resolves it from
   * `portal_users.admin_user_id`; see that service for what happens when the link is absent.
   */
  performedBy?: number;
  /** `campaign_audit_trail.approval_request_id`, for approve/reject/return flows (T-038). */
  approvalRequestId?: number | null;
  /** `campaign_audit_trail.comment` — a checker's rejection reason. Truncated at 500. */
  comment?: string | null;
}

const storage = new AsyncLocalStorage<AuditDraft>();

/**
 * The audit draft context. A namespace of functions rather than an injectable service, for the
 * reason `ScopeContext` gives: `AsyncLocalStorage` is process-global by nature, and injecting it
 * would imply — falsely — that two instances could coexist and mean different things.
 */
export const AuditContext = {
  /** Runs `fn` with `draft` as the current draft. Returns whatever `fn` returns. */
  run<T>(draft: AuditDraft, fn: () => T): T {
    return storage.run(draft, fn);
  },

  /** The current draft, or `undefined` outside an audited handler. */
  current(): AuditDraft | undefined {
    return storage.getStore();
  },

  /**
   * Merges `patch` into the current draft. A no-op outside an audited handler.
   *
   * Returns whether anything was recorded, so `AuditService.annotate` can log the no-op case at
   * `debug` — a service that annotates into the void is usually a missing `@Audit()` decorator,
   * and silence there is how an audit gap gets shipped.
   */
  annotate(patch: AuditDraft): boolean {
    const draft = storage.getStore();
    if (draft === undefined) return false;
    Object.assign(draft, patch);
    return true;
  },
};
