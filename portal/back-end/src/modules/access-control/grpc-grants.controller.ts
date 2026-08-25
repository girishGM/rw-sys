/**
 * T-047 §4d — `/admin/grpc-grants`, the admin surface for the table that decides which service
 * identity may read which sections for which tenants.
 *
 * ### This is a normal portal endpoint, and that is the point
 *
 * Implementation note 14, verbatim: *"a normal `super_admin`-only REST endpoint on the public API,
 * following the exact pattern of `/admin/access-control` — RolesGuard, PermissionsGuard, and a
 * `portal_audit_log` write on every create/update/revoke. It is unrelated to the internal mTLS
 * trust domain the gRPC port and the breach callback live in; **do not accidentally guard it with
 * the mTLS guard instead of the normal session guards**."*
 *
 * So the class-level guard list below is copied from `access-control.controller.ts` rather than
 * invented, for the reason that file gives: this is one of the routes where "the global provider
 * list was edited" must not silently reopen the door — and here the door is the one that decides
 * what an *external system* may read out of every tenant's configuration.
 *
 * Before AR-09 the only way to create a grant was a direct database write: no route, no screen, no
 * audit trail, for a table that is itself an access-control boundary.
 *
 * ### Why there is no `@Audit()` decorator here, unlike `/admin/access-control`
 *
 * Every write below **is** audited — by `GrpcGrantsService`, which calls
 * `AuditService.recordPortalEvent` itself. Adding the decorator as well produced *two*
 * `portal_audit_log` rows per request: the service's, carrying the section/tenant delta §4d asks
 * for, and the interceptor's, carrying `{ method, route }` and nothing else. Two rows for one
 * action is worse than either alone — it makes "how many times was this grant narrowed?"
 * unanswerable by counting.
 *
 * The decorator cannot own this write, because §4d names **three** event types
 * (`grpc_grant_created` / `grpc_grant_updated` / `grpc_grant_revoked`) and the third is decided by
 * the *outcome* of `PATCH`, not by which route was called; `@Audit({ event })` is fixed per route
 * and `AuditDraft` has no event override for portal events. So the service writes, and this
 * controller deliberately does not annotate. T-033's controller keeps its decorators because its
 * events are one-per-route.
 *
 * ### Why this controller is declared by `GrpcModule` and not `AccessControlModule`
 *
 * `access-control.module.ts` belongs to T-033. T-047's file scope carves out exactly two files in
 * this directory — this one and its service — so the module that declares them lives in
 * `src/grpc/` (R9: do not edit another task's owned files). Nest neither knows nor cares which
 * directory a controller's file sits in; the route prefix is what places it beside
 * `/admin/access-control`, and `@Roles('super_admin')` is what protects it.
 */
import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { SessionValidGuard } from '@/modules/auth/guards/session-valid.guard';
import { PasswordChangeRequiredGuard } from '@/modules/auth/guards/password-change-required.guard';
import { MfaRequiredGuard } from '@/modules/auth/guards/mfa-required.guard';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { GRPC_GRANT_ENTITY } from '@/grpc/grpc.constants';
import { CreateGrpcGrantDto, UpdateGrpcGrantDto } from '@/grpc/dto/grpc-grant.dto';
import { GrpcGrantsService, type GrpcServiceGrant } from './grpc-grants.service';

/** The `{ data }` envelope every other admin route returns (03-API-CONTRACT.md §1). */
interface DataEnvelope<T> {
  readonly data: T;
}

@Controller('admin/grpc-grants')
@UseGuards(JwtAuthGuard, SessionValidGuard, PasswordChangeRequiredGuard, MfaRequiredGuard)
@Roles('super_admin')
export class GrpcGrantsController {
  constructor(private readonly service: GrpcGrantsService) {}

  @Get()
  @RequirePermission(GRPC_GRANT_ENTITY, 'view')
  async list(
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<DataEnvelope<readonly GrpcServiceGrant[]>> {
    return { data: await this.service.list(actor) };
  }

  @Get(':id')
  @RequirePermission(GRPC_GRANT_ENTITY, 'view')
  async findOne(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<GrpcServiceGrant>> {
    return { data: await this.service.getById(actor, id) };
  }

  @Post()
  @RequirePermission(GRPC_GRANT_ENTITY, 'create')
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateGrpcGrantDto,
  ): Promise<DataEnvelope<GrpcServiceGrant>> {
    return { data: await this.service.create(actor, dto) };
  }

  @Patch(':id')
  @RequirePermission(GRPC_GRANT_ENTITY, 'update')
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateGrpcGrantDto,
  ): Promise<DataEnvelope<GrpcServiceGrant>> {
    return { data: await this.service.update(actor, id, dto) };
  }
}
