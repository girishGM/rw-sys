/**
 * T-034 — `/tenants` (03-API-CONTRACT.md §6).
 *
 * Thin by design, the same shape `countries.controller.ts` establishes: read the request, call
 * the service, shape the response. Every route carries `@RequirePermission` (`role_entity_
 * permissions`, entity `tenant`/`tenant_budget_ceiling` — T004_001's seed); no route here needs
 * `@Roles` on top of it.
 *
 * `GET /tenants/without-budget-ceiling` is declared **before** `GET /tenants/:id` — both are a
 * single literal/param segment directly under `/tenants`, and Nest/Express match routes in
 * registration order, so `:id` would otherwise swallow the literal path and hand
 * `'without-budget-ceiling'` to `ParseIntPipe`, which is a 400, not the intended handler. Do not
 * reorder these two.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import type { RequestContext } from '@/modules/auth/services/session.service';
import { TENANT_BUDGET_CEILING_ENTITY, TENANT_ENTITY } from './tenants.constants';
import { TenantsService } from './tenants.service';
import { CreateTenantAdminDto } from './dto/create-tenant-admin.dto';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { ListTenantsQueryDto } from './dto/list-tenants-query.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { UpsertBudgetCeilingDto } from './dto/upsert-budget-ceiling.dto';
import {
  envelope,
  type BudgetCeilingDto,
  type CreateTenantResultDto,
  type DataEnvelope,
  type DataListEnvelope,
  type TenantAdminCreatedDto,
  type TenantDto,
  type TenantWithoutCeilingDto,
} from './dto/tenant-response.dto';

/** `request.ip`/`user-agent`, for the audit trail a bulk session revocation writes — the same
 * shape `auth.controller.ts`'s own local `requestContext` helper builds, duplicated here rather
 * than imported since `back-end/src/modules/auth/**` is outside this task's file scope. */
function requestContext(request: Request): RequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    ipAddress: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
  };
}

@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get('without-budget-ceiling')
  @RequirePermission(TENANT_ENTITY, 'view')
  async listWithoutBudgetCeiling(): Promise<DataEnvelope<readonly TenantWithoutCeilingDto[]>> {
    return envelope(await this.tenants.listTenantsWithoutCeiling());
  }

  @Get()
  @RequirePermission(TENANT_ENTITY, 'view')
  async list(@Query() query: ListTenantsQueryDto): Promise<DataListEnvelope<TenantDto>> {
    const { rows, meta } = await this.tenants.list(query);
    return { data: rows, meta };
  }

  @Get(':id')
  @RequirePermission(TENANT_ENTITY, 'view')
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<DataEnvelope<TenantDto>> {
    return envelope(await this.tenants.getById(id));
  }

  @Get(':id/budget-ceilings')
  @RequirePermission(TENANT_BUDGET_CEILING_ENTITY, 'view')
  async getBudgetCeilings(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<readonly BudgetCeilingDto[]>> {
    return envelope(await this.tenants.listBudgetCeilings(id));
  }

  @Post()
  @RequirePermission(TENANT_ENTITY, 'create')
  @Audit({ event: 'tenant_created', targetType: 'tenant' })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateTenantDto,
  ): Promise<DataEnvelope<CreateTenantResultDto>> {
    return envelope(await this.tenants.create(actor, dto));
  }

  @Post(':id/admins')
  @RequirePermission(TENANT_ENTITY, 'update')
  @Audit({ event: 'tenant_admin_created', targetType: 'portal_user' })
  async createAdmin(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateTenantAdminDto,
  ): Promise<DataEnvelope<TenantAdminCreatedDto>> {
    return envelope(await this.tenants.createAdmin(actor, id, dto));
  }

  @Post(':id/activate')
  @RequirePermission(TENANT_ENTITY, 'update')
  @Audit({ event: 'tenant_activated', targetType: 'tenant' })
  async activate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<TenantDto>> {
    return envelope(await this.tenants.activate(actor, id));
  }

  @Patch(':id')
  @RequirePermission(TENANT_ENTITY, 'update')
  @Audit({ event: 'tenant_updated', targetType: 'tenant' })
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTenantDto,
    @Req() request: Request,
  ): Promise<DataEnvelope<TenantDto>> {
    return envelope(await this.tenants.update(actor, id, dto, requestContext(request)));
  }

  @Put(':id/budget-ceilings')
  @RequirePermission(TENANT_BUDGET_CEILING_ENTITY, 'update')
  @Audit({ event: 'tenant_budget_ceiling_updated', targetType: 'tenant' })
  async putBudgetCeilings(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertBudgetCeilingDto,
  ): Promise<DataEnvelope<readonly BudgetCeilingDto[]>> {
    return envelope(await this.tenants.upsertBudgetCeiling(actor, id, dto));
  }
}
