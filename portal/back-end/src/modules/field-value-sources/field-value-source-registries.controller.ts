/**
 * T-121 — `GET/POST/PATCH /field-context-providers` and `/field-api-lookup-providers`.
 *
 * ### Why the reads are `@Roles(...ALL_PORTAL_ROLES)` with no `@RequirePermission`
 *
 * Every role needs to read both registries to render a value-source dropdown (task implementation
 * note 4: *"any authenticated role"*). This is the same choice `rule-registries.controller.ts` and
 * `rule-categories.controller.ts` each make and document for the same reason. `T121_002` still
 * seeds `view` rows for every role — for consistency with every other entity's permission matrix,
 * and so a future permissions-management screen has something real to show — but the read
 * endpoints do not depend on them.
 *
 * The writes do: `@RequirePermission(..., 'create'|'update')` resolves against those seeded rows,
 * where only `super_admin` holds `create`/`update`. `FieldValueSourceRegistriesService` re-checks
 * with `assertRole` (TC-5 asserts the 403 through the HTTP layer, which is what a client actually
 * experiences).
 */
import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import { ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import {
  FIELD_API_LOOKUP_PROVIDER_ENTITY,
  FIELD_CONTEXT_PROVIDER_ENTITY,
} from './field-value-sources.constants';
import { FieldValueSourceRegistriesService } from './field-value-source-registries.service';
import { CreateFieldApiLookupProviderDto } from './dto/create-field-api-lookup-provider.dto';
import { CreateFieldContextProviderDto } from './dto/create-field-context-provider.dto';
import { UpdateFieldApiLookupProviderDto } from './dto/update-field-api-lookup-provider.dto';
import { UpdateFieldContextProviderDto } from './dto/update-field-context-provider.dto';
import {
  envelope,
  type DataEnvelope,
  type FieldApiLookupProviderDto,
  type FieldContextProviderDto,
} from './dto/field-value-source-response.dto';

@Controller()
@Roles(...ALL_PORTAL_ROLES)
export class FieldValueSourceRegistriesController {
  constructor(private readonly registries: FieldValueSourceRegistriesService) {}

  @Get('field-context-providers')
  async listContextProviders(): Promise<DataEnvelope<readonly FieldContextProviderDto[]>> {
    return envelope(await this.registries.listContextProviders());
  }

  @Post('field-context-providers')
  @RequirePermission(FIELD_CONTEXT_PROVIDER_ENTITY, 'create')
  @Audit({ event: 'field_context_provider_created', targetType: 'field_context_provider' })
  async createContextProvider(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateFieldContextProviderDto,
  ): Promise<DataEnvelope<FieldContextProviderDto>> {
    return envelope(await this.registries.createContextProvider(actor, dto));
  }

  @Patch('field-context-providers/:id')
  @RequirePermission(FIELD_CONTEXT_PROVIDER_ENTITY, 'update')
  @Audit({ event: 'field_context_provider_updated', targetType: 'field_context_provider' })
  async updateContextProvider(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateFieldContextProviderDto,
  ): Promise<DataEnvelope<FieldContextProviderDto>> {
    return envelope(await this.registries.updateContextProvider(actor, id, dto));
  }

  @Get('field-api-lookup-providers')
  async listApiLookupProviders(): Promise<DataEnvelope<readonly FieldApiLookupProviderDto[]>> {
    return envelope(await this.registries.listApiLookupProviders());
  }

  @Post('field-api-lookup-providers')
  @RequirePermission(FIELD_API_LOOKUP_PROVIDER_ENTITY, 'create')
  @Audit({ event: 'field_api_lookup_provider_created', targetType: 'field_api_lookup_provider' })
  async createApiLookupProvider(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateFieldApiLookupProviderDto,
  ): Promise<DataEnvelope<FieldApiLookupProviderDto>> {
    return envelope(await this.registries.createApiLookupProvider(actor, dto));
  }

  @Patch('field-api-lookup-providers/:id')
  @RequirePermission(FIELD_API_LOOKUP_PROVIDER_ENTITY, 'update')
  @Audit({ event: 'field_api_lookup_provider_updated', targetType: 'field_api_lookup_provider' })
  async updateApiLookupProvider(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateFieldApiLookupProviderDto,
  ): Promise<DataEnvelope<FieldApiLookupProviderDto>> {
    return envelope(await this.registries.updateApiLookupProvider(actor, id, dto));
  }
}
