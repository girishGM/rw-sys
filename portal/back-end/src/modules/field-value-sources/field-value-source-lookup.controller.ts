/**
 * T-123 — `GET /field-value-sources/context/:providerCode` and
 * `GET /field-value-sources/api/:providerCode`.
 *
 * ### Why `@Roles(...ALL_PORTAL_ROLES)` with no `@RequirePermission`
 *
 * Same reasoning `FieldValueSourceRegistriesController` (T-121) already states for its own reads:
 * these feed a form a Maker (or Super Admin, while authoring) is actively filling in, so every
 * authenticated role needs to reach them (implementation note 3). There is no write here to gate.
 *
 * ### Why the query DTO lives here rather than in `dto/`
 *
 * This task's own `Files owned` names exactly two files. `dto/field-value-source-response.dto.ts`
 * (T-121) already exports a generic `{ data }` envelope this controller reuses unmodified; a new,
 * one-field-different DTO for the `context` route's query string is small enough, and specific
 * enough to this one handler, that a third file would be pure overhead — so it is declared
 * class-validator-first, right where it is used, the same way a one-off DTO for a single handler
 * appears elsewhere in this codebase when it has no other consumer.
 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import { ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';
import { envelope, type DataEnvelope } from './dto/field-value-source-response.dto';
import {
  FieldValueSourceLookupService,
  type ContextComponentOption,
  type FieldValueOption,
} from './field-value-source-lookup.service';

/** `?trackerId=&excludeComponentId=` — implementation note 1. `trackerId` is required: a context
 * lookup with no tracker to read from has nothing to answer. `excludeComponentId` is optional —
 * its absence is the documented "brand-new, not-yet-saved component" case. */
class ContextLookupQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  trackerId!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  excludeComponentId?: number;
}

@Controller('field-value-sources')
@Roles(...ALL_PORTAL_ROLES)
export class FieldValueSourceLookupController {
  constructor(private readonly lookup: FieldValueSourceLookupService) {}

  @Get('context/:providerCode')
  async contextLookup(
    @Param('providerCode') providerCode: string,
    @Query() query: ContextLookupQueryDto,
  ): Promise<DataEnvelope<readonly ContextComponentOption[]>> {
    return envelope(
      await this.lookup.contextLookup(providerCode, query.trackerId, query.excludeComponentId),
    );
  }

  @Get('api/:providerCode')
  async apiLookup(
    @Param('providerCode') providerCode: string,
  ): Promise<DataEnvelope<readonly FieldValueOption[]>> {
    return envelope(await this.lookup.apiLookup(providerCode));
  }
}
