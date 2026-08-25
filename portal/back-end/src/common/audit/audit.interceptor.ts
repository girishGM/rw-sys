/**
 * T-014 — position 11 of 00-ARCHITECTURE.md §6: *"writes `campaign_audit_trail` /
 * `portal_audit_log` on success"*.
 *
 * ### Success-only, and what that precisely means (implementation note 2, TC-6)
 *
 * The row is written from the `concatMap` below, which runs only when the handler's observable
 * **emits a value**. An exception — thrown by the handler, by a service, by a pipe, or surfacing
 * from a rejected promise — short-circuits straight to the exception filter and never reaches
 * it. So "audited" means "the operation completed", which is the only reading under which an
 * audit trail can be used as evidence of what happened.
 *
 * The response *status* is deliberately not consulted. At the moment an interceptor's operators
 * run, Nest has not yet applied `@HttpCode(201)` to the response object, so `res.statusCode` is
 * still the default 200 and testing it would be testing a value that has not been set yet. A
 * successful emission already implies a 2xx: every non-2xx path in Nest is an exception.
 *
 * ### Why `concatMap` rather than `tap`
 *
 * `tap` would start the insert and let the response race it. Two things break when it does: a
 * test that asserts on the row after receiving the response becomes flaky, and — much worse —
 * an incident timeline can show the client being told "done" before the record of it exists.
 * `concatMap` awaits the write, which costs one INSERT of latency on audited routes only, and
 * cannot fail the request because `AuditService` never rejects (note 4, TC-7).
 *
 * ### Why the context is entered inside the subscription
 *
 * Identical to `tenancy-scope.interceptor.ts`, which documents the trap in full: `next.handle()`
 * merely *builds* an observable, so `AuditContext.run(draft, () => next.handle())` would have
 * returned long before the handler ran, and under concurrency the handler could annotate another
 * request's draft. The store must be entered around the **subscription**.
 */
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, concatMap } from 'rxjs';
import type { AuthenticatedRequest } from '@/modules/auth/decorators/current-user.decorator';
import { CHAIN_SPAN, traceSpan } from '@/common/tracing/span.service';
import { AuditContext, type AuditDraft } from './audit-context';
import { AuditService } from './audit.service';
import {
  AUDIT_METADATA,
  isDomainAudit,
  type AuditOptions,
  type DomainAuditOptions,
} from './decorators/audit.decorator';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Handler first, then class: a controller may declare a default `@Audit` and one route
    // override it. `getAllAndOverride` implements exactly that precedence.
    const options = this.reflector.getAllAndOverride<AuditOptions | undefined>(AUDIT_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Not audited, or not an HTTP request (the gRPC port of T-047 carries its own identity and
    // is audited by that task, not by a decorator meant for portal routes).
    if (options === undefined || context.getType() !== 'http') return next.handle();

    const draft: AuditDraft = {};

    return new Observable((subscriber) =>
      AuditContext.run(draft, () =>
        next
          .handle()
          .pipe(
            // T-019 wrapped the write in `audit.write`, stage 8 of 08-OBSERVABILITY.md §5's
            // waterfall. Timing it separately is the point: this is a synchronous INSERT on the
            // response path of every audited route (see "Why `concatMap` rather than `tap`"
            // above), so it is exactly the kind of cost the waterfall exists to make visible.
            // `traceSpan` is a no-op outside a request.
            concatMap(async (body) => {
              await traceSpan(CHAIN_SPAN.AUDIT_WRITE, () => this.write(context, options, draft));
              return body;
            }),
          )
          .subscribe(subscriber),
      ),
    );
  }

  /**
   * Assembles the row from three sources, in a fixed order of authority:
   *
   *  1. the **verified JWT** (`request.authUser`) for the actor and the scope — never a DTO
   *     (AGENT-PROTOCOL R3);
   *  2. the **draft** a service filled in, for the target id, the diff and the campaign;
   *  3. the **decorator** for the event name and target type.
   *
   * Never throws: it delegates to `AuditService`, whose methods cannot reject.
   */
  private async write(
    context: ExecutionContext,
    options: AuditOptions,
    draft: AuditDraft,
  ): Promise<void> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const actor = request.authUser;

    if (isDomainAudit(options)) {
      await this.writeDomainEvent(request, options, draft);
      return;
    }

    await this.audit.recordPortalEvent({
      eventType: options.event,
      actorId: actor?.userId ?? null,
      actorRole: actor?.role ?? null,
      targetType: draft.targetType ?? options.targetType ?? null,
      targetId: draft.targetId ?? paramId(request),
      countryId: actor?.countryId ?? null,
      tenantId: draft.tenantId ?? actor?.tenantId ?? null,
      ipAddress: ipOf(request),
      detail: { method: request.method, route: routePath(request), ...draft.detail },
    });
  }

  /**
   * The `campaign_audit_trail` half. `tenant_id` and `campaign_id` are `NOT NULL`, and neither
   * can be invented: if the handler did not annotate a campaign and the actor's own scope has no
   * tenant, the row is skipped with a loud error rather than guessed at.
   *
   * That is the same trade note 4 makes everywhere else — a gap in the log beats a wrong row in
   * it, and beats a failed request either way — but it is worth being explicit that a *wrong*
   * domain audit row is the worse outcome here: `campaign_audit_trail` is the 7-year, approval-
   * bearing record that a dispute is settled from.
   */
  private async writeDomainEvent(
    request: AuthenticatedRequest,
    options: DomainAuditOptions,
    draft: AuditDraft,
  ): Promise<void> {
    const actor = request.authUser;
    const campaignId = draft.campaignId ?? numericParamId(request);
    const tenantId = draft.tenantId ?? actor?.tenantId ?? null;

    if (campaignId === null || tenantId === null) {
      this.logger.error(
        `AUDIT ROW SKIPPED (campaign_audit_trail) for ${request.method} ${routePath(request)}: ` +
          `campaignId=${String(campaignId)} tenantId=${String(tenantId)}. ` +
          'Call auditService.annotate({ campaignId, tenantId }) from the service that made the change.',
      );
      return;
    }

    await this.audit.recordDomainEvent({
      tenantId,
      campaignId,
      entityType: draft.entityType ?? options.targetType,
      action: draft.action ?? options.event,
      entityId: draft.entityId ?? null,
      fieldChanges: draft.fieldChanges ?? null,
      performedBy: draft.performedBy,
      actorPortalUserId: actor?.userId,
      approvalRequestId: draft.approvalRequestId ?? null,
      comment: draft.comment ?? null,
    });
  }
}

// --- module-private helpers ------------------------------------------------------------------

/** `request.params.id` as a string, when the route has one. The commonest target id by far. */
function paramId(request: AuthenticatedRequest): string | null {
  const id = request.params?.['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** {@link paramId} as an integer, for the `NOT NULL integer` columns of `campaign_audit_trail`. */
function numericParamId(request: AuthenticatedRequest): number | null {
  const id = paramId(request);
  if (id === null || !/^\d+$/.test(id)) return null;
  const parsed = Number.parseInt(id, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** The parameterised route, never the concrete URL (08-OBSERVABILITY.md §3). */
function routePath(request: AuthenticatedRequest): string {
  const route = (request as { route?: { path?: unknown } }).route;
  if (typeof route?.path === 'string') return route.path;
  return typeof request.path === 'string' ? request.path : '';
}

function ipOf(request: AuthenticatedRequest): string | null {
  return typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null;
}
