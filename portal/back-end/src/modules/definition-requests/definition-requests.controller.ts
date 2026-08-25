/**
 * T-042 — `/definition-requests` (06-VERSIONING.md §9/§10). Thin by design, the shape every
 * other Wave 3 controller in this codebase establishes: read the request, call the service,
 * shape the response. Every route carries `@RequirePermission(DEFINITION_REQUEST_ENTITY, …)` —
 * layer 1 of `DefinitionRequestsService`'s three-layer authority story (see that file's header);
 * no route here needs `@Roles` on top of it, the same precedent `rules.controller.ts` sets.
 */
import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { DEFINITION_REQUEST_ENTITY } from './definition-requests.constants';
import { DefinitionRequestsService } from './definition-requests.service';
import { CreateDefinitionRequestDto } from './dto/create-definition-request.dto';
import { UpdateDefinitionRequestDto } from './dto/update-definition-request.dto';
import { ReviewDefinitionRequestDto } from './dto/review-definition-request.dto';
import { FulfilDefinitionRequestDto } from './dto/fulfil-definition-request.dto';
import { ListDefinitionRequestsQueryDto } from './dto/list-definition-requests-query.dto';
import {
  envelope,
  type DataEnvelope,
  type DataListEnvelope,
  type DefinitionRequestDto,
} from './dto/definition-request-response.dto';

@Controller('definition-requests')
export class DefinitionRequestsController {
  constructor(private readonly definitionRequests: DefinitionRequestsService) {}

  @Get()
  @RequirePermission(DEFINITION_REQUEST_ENTITY, 'view')
  async list(
    @Query() query: ListDefinitionRequestsQueryDto,
  ): Promise<DataListEnvelope<DefinitionRequestDto>> {
    const { rows, meta } = await this.definitionRequests.list(query);
    return { data: rows, meta };
  }

  @Get(':id')
  @RequirePermission(DEFINITION_REQUEST_ENTITY, 'view')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<DefinitionRequestDto>> {
    return envelope(await this.definitionRequests.getById(id));
  }

  @Post()
  @RequirePermission(DEFINITION_REQUEST_ENTITY, 'create')
  @Audit({ event: 'definition_request_submitted', targetType: 'definition_request' })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateDefinitionRequestDto,
  ): Promise<DataEnvelope<DefinitionRequestDto>> {
    return envelope(await this.definitionRequests.create(actor, dto));
  }

  @Patch(':id')
  @RequirePermission(DEFINITION_REQUEST_ENTITY, 'update')
  @Audit({ event: 'definition_request_updated', targetType: 'definition_request' })
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDefinitionRequestDto,
  ): Promise<DataEnvelope<DefinitionRequestDto>> {
    return envelope(await this.definitionRequests.update(actor, id, dto));
  }

  @Post(':id/withdraw')
  @RequirePermission(DEFINITION_REQUEST_ENTITY, 'withdraw')
  @Audit({ event: 'definition_request_withdrawn', targetType: 'definition_request' })
  async withdraw(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<DefinitionRequestDto>> {
    return envelope(await this.definitionRequests.withdraw(actor, id));
  }

  @Post(':id/review')
  @RequirePermission(DEFINITION_REQUEST_ENTITY, 'review')
  @Audit({ event: 'definition_request_reviewed', targetType: 'definition_request' })
  async review(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewDefinitionRequestDto,
  ): Promise<DataEnvelope<DefinitionRequestDto>> {
    return envelope(await this.definitionRequests.review(actor, id, dto));
  }

  @Post(':id/fulfil')
  @RequirePermission(DEFINITION_REQUEST_ENTITY, 'fulfil')
  @Audit({ event: 'definition_request_fulfilled', targetType: 'definition_request' })
  async fulfil(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: FulfilDefinitionRequestDto,
  ): Promise<DataEnvelope<DefinitionRequestDto>> {
    return envelope(await this.definitionRequests.fulfil(actor, id, dto));
  }
}
