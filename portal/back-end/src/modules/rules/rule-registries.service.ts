/**
 * T-108 — `GET /rule-resolvers`, `GET /rule-operators`. Read-only reference data, reachable by
 * every role — same reasoning `rules.service.ts#listCategories` documents: these are Super
 * Admin-owned, seed-managed registries (T-102), not per-tenant/per-country data, so a plain
 * `listAll` is correct rather than a raw `Model.findAll()` (R2).
 */
import { Injectable } from '@nestjs/common';
import { RuleOperator, RuleResolver } from '@/database/models';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import {
  toRuleOperatorDto,
  toRuleResolverDto,
  type RuleOperatorDto,
  type RuleResolverDto,
} from './dto/rule-registry-response.dto';

@Injectable()
export class RuleRegistriesService {
  constructor(private readonly scoped: ScopedRepository) {}

  async listResolvers(): Promise<RuleResolverDto[]> {
    const rows = await this.scoped.listAll(RuleResolver, { order: [['name', 'ASC']] });
    return rows.map(toRuleResolverDto);
  }

  async listOperators(): Promise<RuleOperatorDto[]> {
    const rows = await this.scoped.listAll(RuleOperator, { order: [['operatorCode', 'ASC']] });
    return rows.map(toRuleOperatorDto);
  }
}
