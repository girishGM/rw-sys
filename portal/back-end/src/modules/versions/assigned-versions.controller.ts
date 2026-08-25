/**
 * T-041 — `GET /countries/:id/assigned-versions`. `@RequirePermission(COUNTRY_ENTITY, 'view')`
 * is a deliberate reuse, not a shortcut: T004_001's seed grants `country:view` to exactly
 * `super_admin` and `country_admin` — precisely the two roles the Endpoints table names for
 * this route — so no dedicated permission entity is needed (`versions.constants.ts`'s header
 * has the fuller reasoning for why this module has no entity of its own).
 *
 * Physically inside `modules/versions/**` even though it mounts under `/countries` — the route
 * path and the owning `Files owned` directory are independent (05-EXECUTION-PLAN.md); this
 * endpoint's whole subject is version assignment, `versions.module.ts`'s own scope.
 */
import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import { COUNTRY_ENTITY } from '@/modules/countries/countries.constants';
import { AssignedVersionsService } from './assigned-versions.service';
import { envelope, type AssignedVersionDto, type DataEnvelope } from './dto/version-response.dto';

@Controller('countries/:id/assigned-versions')
export class AssignedVersionsController {
  constructor(private readonly assignedVersions: AssignedVersionsService) {}

  @Get()
  @RequirePermission(COUNTRY_ENTITY, 'view')
  async list(
    @Param('id', ParseIntPipe) countryId: number,
  ): Promise<DataEnvelope<readonly AssignedVersionDto[]>> {
    return envelope(await this.assignedVersions.listForCountry(countryId));
  }
}
