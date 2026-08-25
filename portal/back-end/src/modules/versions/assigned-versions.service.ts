/**
 * T-041 — `GET /countries/:id/assigned-versions` (06-VERSIONING.md §10, "Country → Assigned
 * versions"). Read-only: which rule/reward versions a country currently holds, rules and
 * rewards together in one list.
 *
 * `findByPkOrFail(Country, id)` first, mirroring `CountriesService.getById`'s own pattern
 * (T-030): `Country`'s scope-strategy entry already 404s an out-of-scope country id for
 * `country_admin`/`tenant_admin` before either assignment table is even queried, so this
 * service never hand-writes a `countryId === actor.countryId` comparison — the same
 * "computed once, in the one place T-013 already proved correct" discipline
 * `RulesService`'s own header documents for rule visibility.
 */
import { Injectable } from '@nestjs/common';
import {
  Country,
  RewardVersion,
  RewardVersionCountryAssignment,
  RuleMaster,
  RuleVersion,
  RuleVersionCountryAssignment,
} from '@/database/models';
import { RewardSystem } from '@/database/models/reward-system.model';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import type { AssignedVersionDto } from './dto/version-response.dto';

@Injectable()
export class AssignedVersionsService {
  constructor(private readonly scoped: ScopedRepository) {}

  async listForCountry(countryId: number): Promise<readonly AssignedVersionDto[]> {
    await this.scoped.findByPkOrFail(Country, countryId);

    const [ruleRows, rewardRows] = await Promise.all([
      this.scoped.listAll(RuleVersionCountryAssignment, {
        where: { countryId },
        include: [{ model: RuleVersion, include: [RuleMaster] }],
        order: [['assignedAt', 'DESC']],
      }),
      this.scoped.listAll(RewardVersionCountryAssignment, {
        where: { countryId },
        include: [{ model: RewardVersion, include: [RewardSystem] }],
        order: [['assignedAt', 'DESC']],
      }),
    ]);

    const rules: AssignedVersionDto[] = (
      ruleRows as (RuleVersionCountryAssignment & {
        ruleVersion: RuleVersion & { rule: RuleMaster };
      })[]
    ).map((row) => ({
      entityType: 'rule',
      entityId: row.ruleId,
      entityCode: row.ruleVersion.rule.ruleCode,
      entityName: row.ruleVersion.rule.name,
      versionId: row.ruleVersionId,
      versionNo: row.ruleVersion.versionNo,
      status: row.status,
      effectiveFrom: row.effectiveFrom.toISOString(),
      effectiveTo: row.effectiveTo?.toISOString() ?? null,
    }));

    const rewards: AssignedVersionDto[] = (
      rewardRows as (RewardVersionCountryAssignment & {
        rewardVersion: RewardVersion & { reward: RewardSystem };
      })[]
    ).map((row) => ({
      entityType: 'reward',
      entityId: row.rewardId,
      entityCode: row.rewardVersion.reward.systemCode,
      entityName: row.rewardVersion.reward.name,
      versionId: row.rewardVersionId,
      versionNo: row.rewardVersion.versionNo,
      status: row.status,
      effectiveFrom: row.effectiveFrom.toISOString(),
      effectiveTo: row.effectiveTo?.toISOString() ?? null,
    }));

    return [...rules, ...rewards];
  }
}
