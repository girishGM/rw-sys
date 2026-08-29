/**
 * T-108 — `GET /rule-resolvers`, `GET /rule-operators`.
 *
 * `@Roles(...ALL_PORTAL_ROLES)`, no `@RequirePermission` — the same choice
 * `rule-categories.controller.ts` makes for the same reason: there is no `rule_resolver`/
 * `rule_operator` row in `role_entity_permissions`, because this is reference data every role
 * needs to render a resolver/operator picker, not an entity a runtime permission table gates.
 * Create/edit/delete deliberately do not exist here — see `T-108-registries-read-api.md`.
 */
import { Controller, Get } from '@nestjs/common';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import { ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';
import { RuleRegistriesService } from './rule-registries.service';
import { envelope, type DataEnvelope } from './dto/rule-response.dto';
import type { RuleOperatorDto, RuleResolverDto } from './dto/rule-registry-response.dto';

@Controller()
@Roles(...ALL_PORTAL_ROLES)
export class RuleRegistriesController {
  constructor(private readonly registries: RuleRegistriesService) {}

  @Get('rule-resolvers')
  async listResolvers(): Promise<DataEnvelope<readonly RuleResolverDto[]>> {
    return envelope(await this.registries.listResolvers());
  }

  @Get('rule-operators')
  async listOperators(): Promise<DataEnvelope<readonly RuleOperatorDto[]>> {
    return envelope(await this.registries.listOperators());
  }
}
