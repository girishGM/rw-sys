/**
 * T-031 — `/rules` (03-API-CONTRACT.md §8).
 *
 * Thin by design, in the shape `countries.controller.ts` establishes: read the request, call
 * the service, shape the response. Every route carries `@RequirePermission` (`rule`/
 * `rule_assignment` entities, T004_001's seed) — layer 1 of `RulesService`'s three-layer
 * authority story (see that file's header); no route here needs `@Roles` on top of it.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { RULE_ASSIGNMENT_ENTITY, RULE_ENTITY } from './rules.constants';
import { RulesService } from './rules.service';
import { AssignRuleCountryDto } from './dto/assign-rule-country.dto';
import { CreateRuleDto } from './dto/create-rule.dto';
import { ListRulesQueryDto } from './dto/list-rules-query.dto';
import { UpdateRuleDto } from './dto/update-rule.dto';
import {
  envelope,
  type DataEnvelope,
  type DataListEnvelope,
  type RuleCountryAssignmentDto,
  type RuleDto,
} from './dto/rule-response.dto';

@Controller('rules')
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get()
  @RequirePermission(RULE_ENTITY, 'view')
  async list(@Query() query: ListRulesQueryDto): Promise<DataListEnvelope<RuleDto>> {
    const { rows, meta } = await this.rules.list(query);
    return { data: rows, meta };
  }

  @Get(':id')
  @RequirePermission(RULE_ENTITY, 'view')
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<DataEnvelope<RuleDto>> {
    return envelope(await this.rules.getById(id));
  }

  @Get(':id/parameters')
  @RequirePermission(RULE_ENTITY, 'view')
  async parameters(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<Record<string, unknown>>> {
    return envelope(await this.rules.getParameters(id));
  }

  @Post()
  @RequirePermission(RULE_ENTITY, 'create')
  @Audit({ event: 'rule_created', targetType: 'rule' })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateRuleDto,
  ): Promise<DataEnvelope<RuleDto>> {
    return envelope(await this.rules.create(actor, dto));
  }

  @Patch(':id')
  @RequirePermission(RULE_ENTITY, 'update')
  @Audit({ event: 'rule_updated', targetType: 'rule' })
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRuleDto,
  ): Promise<DataEnvelope<RuleDto>> {
    return envelope(await this.rules.update(actor, id, dto));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(RULE_ENTITY, 'delete')
  @Audit({ event: 'rule_deleted', targetType: 'rule' })
  async remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    await this.rules.remove(actor, id);
  }

  @Get(':id/countries')
  @RequirePermission(RULE_ASSIGNMENT_ENTITY, 'view')
  async listCountries(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<readonly RuleCountryAssignmentDto[]>> {
    return envelope(await this.rules.listCountryAssignments(id));
  }

  @Post(':id/countries')
  @RequirePermission(RULE_ASSIGNMENT_ENTITY, 'create')
  @Audit({ event: 'rule_assigned', targetType: 'rule_assignment' })
  async assignCountry(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignRuleCountryDto,
  ): Promise<DataEnvelope<RuleCountryAssignmentDto>> {
    return envelope(await this.rules.assignToCountry(actor, id, dto));
  }

  @Delete(':id/countries/:countryId')
  @HttpCode(204)
  @RequirePermission(RULE_ASSIGNMENT_ENTITY, 'delete')
  @Audit({ event: 'rule_unassigned', targetType: 'rule_assignment' })
  async unassignCountry(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('countryId', ParseIntPipe) countryId: number,
  ): Promise<void> {
    await this.rules.unassignFromCountry(actor, id, countryId);
  }
}
