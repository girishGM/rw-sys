/**
 * T-030 — `/countries` (03-API-CONTRACT.md §5).
 *
 * Thin by design, in the shape `me.controller.ts` and `trace.controller.ts` establish: read the
 * request, call the service, shape the response. Every route carries `@RequirePermission`
 * (`role_entity_permissions`, entity `country` — T004_001's seed), which is layer 1 of
 * `CountriesService`'s three-layer authority story; no route here needs `@Roles` on top of it
 * (`PermissionsGuard`'s own header: "A route carrying only `@RequirePermission` is guarded by
 * layer 2 alone").
 */
import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { COUNTRY_ENTITY } from './countries.constants';
import { CountriesService } from './countries.service';
import { CreateCountryAdminDto } from './dto/create-country-admin.dto';
import { CreateCountryDto } from './dto/create-country.dto';
import { ListCountriesQueryDto } from './dto/list-countries-query.dto';
import { UpdateCountryDto } from './dto/update-country.dto';
import {
  envelope,
  type CountryAdminCreatedDto,
  type CountryDto,
  type CountrySummaryDto,
  type CreateCountryResultDto,
  type DataEnvelope,
  type DataListEnvelope,
} from './dto/country-response.dto';

@Controller('countries')
export class CountriesController {
  constructor(private readonly countries: CountriesService) {}

  @Get()
  @RequirePermission(COUNTRY_ENTITY, 'view')
  async list(@Query() query: ListCountriesQueryDto): Promise<DataListEnvelope<CountryDto>> {
    const { rows, meta } = await this.countries.list(query);
    return { data: rows, meta };
  }

  @Get(':id')
  @RequirePermission(COUNTRY_ENTITY, 'view')
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<DataEnvelope<CountryDto>> {
    return envelope(await this.countries.getById(id));
  }

  @Get(':id/summary')
  @RequirePermission(COUNTRY_ENTITY, 'view')
  async summary(@Param('id', ParseIntPipe) id: number): Promise<DataEnvelope<CountrySummaryDto>> {
    return envelope(await this.countries.summary(id));
  }

  @Post()
  @RequirePermission(COUNTRY_ENTITY, 'create')
  @Audit({ event: 'country_created', targetType: 'country' })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateCountryDto,
  ): Promise<DataEnvelope<CreateCountryResultDto>> {
    return envelope(await this.countries.create(actor, dto));
  }

  @Post(':id/admins')
  @RequirePermission(COUNTRY_ENTITY, 'update')
  @Audit({ event: 'country_admin_created', targetType: 'portal_user' })
  async createAdmin(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateCountryAdminDto,
  ): Promise<DataEnvelope<CountryAdminCreatedDto>> {
    return envelope(await this.countries.createAdmin(actor, id, dto));
  }

  @Patch(':id')
  @RequirePermission(COUNTRY_ENTITY, 'update')
  @Audit({ event: 'country_updated', targetType: 'country' })
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCountryDto,
  ): Promise<DataEnvelope<CountryDto>> {
    return envelope(await this.countries.update(actor, id, dto));
  }
}
