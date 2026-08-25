/**
 * T-036 — `/merchants` (03-API-CONTRACT.md, Tenant Admin merchant directory).
 *
 * Thin by design, the same shape `tenants.controller.ts` establishes: read the request, call the
 * service, shape the response. Every route carries `@RequirePermission` (`role_entity_
 * permissions`, entity `merchant` — T004_001's seed); no route here needs `@Roles` on top of it.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
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
import { MERCHANT_ENTITY } from './merchants.constants';
import { MerchantsService } from './merchants.service';
import { CreateMerchantActivityDto } from './dto/create-merchant-activity.dto';
import { CreateMerchantStoreDto } from './dto/create-merchant-store.dto';
import { CreateMerchantDto } from './dto/create-merchant.dto';
import { ListMerchantsQueryDto } from './dto/list-merchants-query.dto';
import { UpdateMerchantDto } from './dto/update-merchant.dto';
import {
  envelope,
  type ActiveCampaignDto,
  type DataEnvelope,
  type DataListEnvelope,
  type MerchantActivityDto,
  type MerchantDto,
  type MerchantStoreDto,
} from './dto/merchant-response.dto';

/** `request.ip`/`user-agent`, for the audit trail a bulk session revocation writes — the same
 * shape `tenants.controller.ts`'s own local `requestContext` helper builds, duplicated here
 * rather than imported since `back-end/src/modules/auth/**` is outside this task's file scope. */
function requestContext(request: Request): RequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    ipAddress: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
  };
}

@Controller('merchants')
export class MerchantsController {
  constructor(private readonly merchants: MerchantsService) {}

  @Get()
  @RequirePermission(MERCHANT_ENTITY, 'view')
  async list(@Query() query: ListMerchantsQueryDto): Promise<DataListEnvelope<MerchantDto>> {
    const { rows, meta } = await this.merchants.list(query);
    return { data: rows, meta };
  }

  @Get(':id')
  @RequirePermission(MERCHANT_ENTITY, 'view')
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<DataEnvelope<MerchantDto>> {
    return envelope(await this.merchants.getById(id));
  }

  @Get(':id/active-campaigns')
  @RequirePermission(MERCHANT_ENTITY, 'view')
  async activeCampaigns(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<readonly ActiveCampaignDto[]>> {
    return envelope(await this.merchants.listActiveCampaigns(id));
  }

  @Get(':id/stores')
  @RequirePermission(MERCHANT_ENTITY, 'view')
  async listStores(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<readonly MerchantStoreDto[]>> {
    return envelope(await this.merchants.listStores(id));
  }

  @Get(':id/activities')
  @RequirePermission(MERCHANT_ENTITY, 'view')
  async listActivities(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<readonly MerchantActivityDto[]>> {
    return envelope(await this.merchants.listActivities(id));
  }

  @Post()
  @RequirePermission(MERCHANT_ENTITY, 'create')
  @Audit({ event: 'merchant_created', targetType: 'merchant' })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateMerchantDto,
  ): Promise<DataEnvelope<MerchantDto>> {
    return envelope(await this.merchants.create(actor, dto));
  }

  @Patch(':id')
  @RequirePermission(MERCHANT_ENTITY, 'update')
  @Audit({ event: 'merchant_updated', targetType: 'merchant' })
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMerchantDto,
    @Req() request: Request,
  ): Promise<DataEnvelope<MerchantDto>> {
    return envelope(await this.merchants.update(actor, id, dto, requestContext(request)));
  }

  @Post(':id/stores')
  @RequirePermission(MERCHANT_ENTITY, 'create')
  @Audit({ event: 'merchant_store_created', targetType: 'merchant' })
  async createStore(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateMerchantStoreDto,
  ): Promise<DataEnvelope<MerchantStoreDto>> {
    return envelope(await this.merchants.createStore(actor, id, dto));
  }

  @Post(':id/activities')
  @RequirePermission(MERCHANT_ENTITY, 'create')
  @Audit({ event: 'merchant_activity_linked', targetType: 'merchant' })
  async createActivity(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateMerchantActivityDto,
  ): Promise<DataEnvelope<MerchantActivityDto>> {
    return envelope(await this.merchants.createActivity(actor, id, dto));
  }
}
