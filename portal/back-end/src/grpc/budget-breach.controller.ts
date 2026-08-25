/**
 * T-047 — `POST /internal/v1/campaigns/:id/budget-breach` (09-INTEGRATION.md §7a, architect
 * review AR-01).
 *
 * ### Why a mutating route exists at all next to a deliberately read-only service
 *
 * 11-BUDGETS-AND-LIMITS.md §4.5 specifies `campaign_caps.on_breach = 'pause_campaign'`: *"flip the
 * campaign to `paused`, stopping everything and notifying."* Campaign status is a portal-owned
 * column; the runtime owns the budget counters and is the only party that knows the instant a
 * breach occurs. As originally specified that behaviour had **no path to execute** — the gRPC
 * service is read-only, so nothing could tell the portal a breach had happened.
 *
 * > *"The fix is not to weaken the gRPC read-only guarantee. It stays exactly as strict as §7
 * > describes — no mutating RPC in the proto, `SELECT`-only DB role. Instead, one narrow,
 * > single-purpose REST callback exists **alongside** gRPC, in the same trust domain."*
 *
 * So this is deliberately **not** in the `.proto` (the contract test greps for that), and it is
 * deliberately **not** a Nest controller on `/api/v1`: it is a handler on the same mTLS listener,
 * which is what makes "no portal session is accepted here" (TC-41) and "same client-cert allowlist"
 * (TC-38, TC-39) properties of the socket rather than of a guard.
 *
 * ### What it can do — nothing new
 *
 * It calls `CampaignsService.pauseFromRuntime`, which shares its transition, its state-machine
 * guard and its change event with the `tenant_admin` pause. It cannot create, edit or approve
 * anything; the only status it can produce is `paused`, and only from `active`.
 */
import { Injectable } from '@nestjs/common';
import { CampaignsService } from '@/modules/campaigns/campaigns.service';
import {
  BREACH_MAX_BODY_BYTES,
  BUDGET_BREACH_PATH_PATTERN,
  CONFIG_SECTION,
} from './grpc.constants';
import { GrpcError, GrpcStatus } from './grpc.errors';
import { assertMutualTls, assertNoPortalCredentials } from './mtls.guard';
import { runAsGlobalGrantHolder, runAsTenant } from './internal-read.scope';
import { ServiceScopeGuard } from './service-scope.guard';
import { resolveSections } from './section-grant.guard';
import { GrpcAccessLog } from './access-log';
import type { CallContext, InternalTlsListener, RestResult } from './wire/grpc-http2.server';

/** The documented body: `{ capId: int, breachedAt: RFC3339, observedTotal: "500012.40" }`. */
interface BreachBody {
  readonly capId: number;
  readonly breachedAt: string;
  readonly observedTotal: string;
}

@Injectable()
export class BudgetBreachController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly scopeGuard: ServiceScopeGuard,
    private readonly accessLog: GrpcAccessLog,
  ) {}

  /** Wires the route onto `listener`. Called once, by `grpc.module.ts`, at boot. */
  register(listener: InternalTlsListener): void {
    listener.registerRest(async (context, method, body) => this.handle(context, method, body));
  }

  private async handle(context: CallContext, method: string, rawBody: Buffer): Promise<RestResult> {
    const started = Date.now();
    const match = BUDGET_BREACH_PATH_PATTERN.exec(context.path);
    if (match === null || method.toUpperCase() !== 'POST') {
      // Not 405-with-Allow: this listener has exactly one route, and enumerating what it does not
      // serve to an unauthenticated caller tells them about a surface they cannot use.
      throw new GrpcError(GrpcStatus.NOT_FOUND, 'no such internal route');
    }

    // Identical to the gRPC path, and in the same order — §7a: *"Same mTLS handshake and
    // client-cert SAN allowlist as the gRPC port"*, *"No portal session accepted"*.
    assertNoPortalCredentials(context.headers);
    const candidates = assertMutualTls(context.peer);
    const caller = await this.scopeGuard.resolve(candidates);

    const campaignId = Number(match[1]);
    const body = parseBody(rawBody);

    // **The campaign's tenant is never taken from the request.** It is derived from the grant and
    // the campaign row, so a runtime cannot report a breach "on behalf of" a tenant it may not read
    // (TC-39, and R3's rule about client-supplied scope applied to a service caller).
    //
    // Two shapes, because a grant may name a tenant or be global:
    //
    //  - **tenant-specific grants** — each is a candidate; the campaign is loaded under that
    //    tenant's scope and the first grant that can see it wins. `ScopedRepository` answers "not
    //    found" rather than "not yours", so a miss is indistinguishable from absence and simply
    //    moves to the next candidate. For the overwhelmingly common single-grant case that is
    //    exactly one query.
    //  - **a global grant** — the identity may read every tenant, so the campaign is loaded once
    //    to discover *its* tenant, and everything after that is scoped to that tenant exactly as
    //    the tenant-specific path is.
    const globalGrant = caller.grants.find((grant) => grant.tenantId === null);
    const candidateTenantIds = caller.grants
      .map((grant) => grant.tenantId)
      .filter((id): id is number => id !== null);

    if (globalGrant !== undefined) {
      const discovered = await runAsGlobalGrantHolder(async () => {
        try {
          return (await this.campaigns.loadCampaign(campaignId)).tenantId;
        } catch (error) {
          if (isScopeMiss(error)) return null;
          throw error;
        }
      });
      if (discovered !== null && !candidateTenantIds.includes(discovered)) {
        candidateTenantIds.push(discovered);
      }
    }

    for (const tenantId of candidateTenantIds) {
      // Section grant is checked too: a breach report is a statement about caps, so an identity
      // that may not read `CAPS` may not act on them either.
      const grant = this.scopeGuard.grantFor(caller, tenantId);
      resolveSections(caller.identity, grant.allowedSections, [CONFIG_SECTION.CAPS]);

      const outcome = await runAsTenant(tenantId, null, async () => {
        try {
          return await this.campaigns.pauseFromRuntime({
            campaignId,
            tenantId,
            serviceIdentity: caller.identity,
            capId: body.capId,
            observedTotal: body.observedTotal,
            breachedAt: body.breachedAt,
          });
        } catch (error) {
          // A campaign in another tenant is unreachable through `ScopedRepository`, which answers
          // "not found" rather than "not yours" — so this is a miss, not a denial, and the next
          // granted tenant is tried.
          if (isScopeMiss(error)) return null;
          throw error;
        }
      });

      if (outcome !== null) {
        this.accessLog.record({
          method: 'BudgetBreach',
          identity: caller.identity,
          tenantId,
          campaignCode: outcome.campaignCode,
          status: GrpcStatus.OK,
          durationMs: Date.now() - started,
        });
        return {
          status: 200,
          body: {
            data: {
              campaignId,
              campaignCode: outcome.campaignCode,
              status: outcome.status,
              // `false` when the campaign was already paused — TC-40's idempotent retry.
              paused: outcome.paused,
            },
          },
        };
      }
    }

    this.accessLog.record({
      method: 'BudgetBreach',
      identity: caller.identity,
      tenantId: null,
      status: GrpcStatus.PERMISSION_DENIED,
      durationMs: Date.now() - started,
    });
    // TC-39. `PERMISSION_DENIED`, not `NOT_FOUND`, for the same reason as every gRPC read: this is
    // a peer service, and a grant that needs fixing must look like a grant that needs fixing.
    throw new GrpcError(
      GrpcStatus.PERMISSION_DENIED,
      `service identity "${caller.identity}" holds no grant covering campaign ${campaignId}`,
    );
  }
}

/** A `ScopedRepository` miss — the row is absent or out of scope, indistinguishably. */
function isScopeMiss(error: unknown): boolean {
  return error instanceof Error && error.name === 'ScopeViolationError';
}

/**
 * The body, validated.
 *
 * Hand-validated rather than through `class-validator`: this route is not on the Nest HTTP adapter,
 * so the global `ValidationPipe` never sees it. The three fields are checked exactly as §7a
 * documents them, and `observedTotal` is required to be a **decimal string** — never a number —
 * because §4b bans floats from this boundary outright.
 */
function parseBody(raw: Buffer): BreachBody {
  if (raw.length > BREACH_MAX_BODY_BYTES) {
    throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, 'request body is too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, 'request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, 'request body must be an object');
  }

  const body = parsed as Record<string, unknown>;
  const capId = body['capId'];
  const breachedAt = body['breachedAt'];
  const observedTotal = body['observedTotal'];

  if (typeof capId !== 'number' || !Number.isSafeInteger(capId) || capId <= 0) {
    throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, 'capId must be a positive integer');
  }
  if (typeof breachedAt !== 'string' || Number.isNaN(Date.parse(breachedAt))) {
    throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, 'breachedAt must be an RFC3339 timestamp');
  }
  if (typeof observedTotal !== 'string' || !/^\d{1,18}(\.\d{1,6})?$/.test(observedTotal)) {
    throw new GrpcError(
      GrpcStatus.INVALID_ARGUMENT,
      'observedTotal must be a decimal string (never a float — 09-INTEGRATION.md §4b)',
    );
  }
  return { capId, breachedAt, observedTotal };
}
