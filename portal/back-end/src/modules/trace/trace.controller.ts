/**
 * T-045 — `GET /api/v1/audit/trace/:correlationId` (08-OBSERVABILITY.md §6).
 *
 * Thin, in the shape `me.controller.ts` and `reveal.controller.ts` establish: the controller
 * validates nothing itself (the path parameter is untyped by design — `TraceService.assemble`
 * validates it against 08-OBSERVABILITY.md §1's pattern before any query runs, exactly the
 * "validated before it reaches any query or log line" property implementation note 4 asks for),
 * and every decision of substance lives in the service, where it is unit-testable without an
 * HTTP request.
 *
 * ### `@Roles('super_admin')` — do not widen this
 *
 * Implementation note 1, verbatim: *"A trace aggregates data across tenants by nature, so it
 * cannot be safely scoped to a lower role. State this in the code comment so nobody 'fixes' it
 * later by relaxing the guard."* There is no `@RequirePermission` alongside it — unlike an
 * entity a Super Admin could delegate through `role_entity_permissions`, cross-tenant
 * observability is not a permission this application ever grants to a configurable set of roles.
 * TC-9/TC-10 are the negative-authorisation tests AGENT-PROTOCOL R6 requires; there is no
 * "wrong tenant" variant of this endpoint's own 403/404 pair because there is no tenant
 * parameter for one to be wrong about — TC-6 (an id that matches nothing) is this endpoint's
 * equivalent existence check, and it is a 404 for the same reason `ScopeViolationError` is one
 * everywhere else in this codebase (02-SECURITY.md §5.1).
 */
import { Controller, Get, Param } from '@nestjs/common';
import type { TraceResponse } from '@reward-portal/shared';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import { traceEnvelope } from './dto/trace-response.dto';
import { TraceService } from './trace.service';

export interface TraceEnvelope {
  readonly data: TraceResponse;
}

@Controller('audit/trace')
@Roles('super_admin')
export class TraceController {
  constructor(private readonly trace: TraceService) {}

  @Get(':correlationId')
  @Audit({ event: 'trace_viewed', targetType: 'trace' })
  async getTrace(@Param('correlationId') correlationId: string): Promise<TraceEnvelope> {
    return traceEnvelope(await this.trace.assemble(correlationId));
  }
}
