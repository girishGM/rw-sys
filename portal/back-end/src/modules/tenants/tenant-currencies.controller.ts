/**
 * T-126 — `/tenants/:id/currencies` (13-REWARD-MASTER-VALUE-SOURCES.md §4).
 *
 * Thin by design, the same shape `tenants.controller.ts`'s own header establishes: read the
 * request, call the service, shape the response. Every route carries `@RequirePermission`
 * (`tenant_currency`, T126_002's seed); `create`/`update` are further restricted to `super_admin`
 * at the service layer (`assertRole`, R6's "two independent layers").
 *
 * A separate controller/service rather than folding into `tenants.controller.ts`/
 * `tenants.service.ts` — that file is already `done` (T-034) and R9 treats it as another task's
 * surface even though this task shares the module directory; a new, additive pair of files here,
 * wired into the existing `tenants.module.ts`, changes nothing about `/tenants` itself.
 */
import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { TENANT_CURRENCY_ENTITY } from './tenants.constants';
import { TenantCurrenciesService } from './tenant-currencies.service';
import { CreateTenantCurrencyDto } from './dto/create-tenant-currency.dto';
import { UpdateTenantCurrencyDto } from './dto/update-tenant-currency.dto';
import { envelope, type DataEnvelope } from './dto/tenant-response.dto';
import type { TenantCurrencyDto } from './dto/tenant-currency-response.dto';

@Controller('tenants')
export class TenantCurrenciesController {
  constructor(private readonly currencies: TenantCurrenciesService) {}

  @Get(':id/currencies')
  @RequirePermission(TENANT_CURRENCY_ENTITY, 'view')
  async list(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<readonly TenantCurrencyDto[]>> {
    return envelope(await this.currencies.list(id));
  }

  @Post(':id/currencies')
  @RequirePermission(TENANT_CURRENCY_ENTITY, 'create')
  @Audit({ event: 'tenant_currency_created', targetType: 'tenant_currency' })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateTenantCurrencyDto,
  ): Promise<DataEnvelope<TenantCurrencyDto>> {
    return envelope(await this.currencies.create(actor, id, dto));
  }

  @Patch(':id/currencies/:currencyId')
  @RequirePermission(TENANT_CURRENCY_ENTITY, 'update')
  @Audit({ event: 'tenant_currency_updated', targetType: 'tenant_currency' })
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('currencyId', ParseIntPipe) currencyId: number,
    @Body() dto: UpdateTenantCurrencyDto,
  ): Promise<DataEnvelope<TenantCurrencyDto>> {
    return envelope(await this.currencies.update(actor, id, currencyId, dto));
  }
}
