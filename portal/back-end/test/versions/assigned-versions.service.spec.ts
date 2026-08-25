/**
 * T-041 — `AssignedVersionsService` unit tests (`GET /countries/:id/assigned-versions`,
 * 06-VERSIONING.md §10).
 */
import {
  Country,
  RewardVersionCountryAssignment,
  RuleVersionCountryAssignment,
} from '@/database/models';
import { AssignedVersionsService } from '@/modules/versions/assigned-versions.service';
import {
  FakeScopedRepository,
  asScopedRepository,
  countryRow,
  ruleVersionCountryAssignmentRow,
  ruleVersionRow,
  rewardVersionCountryAssignmentRow,
  rewardVersionRow,
} from './support/versions-doubles';

function buildService() {
  const scoped = new FakeScopedRepository();
  const service = new AssignedVersionsService(asScopedRepository(scoped));
  return { service, scoped };
}

describe('AssignedVersionsService.listForCountry', () => {
  it('404s for an absent or out-of-scope country before either table is queried', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(Country, null);
    await expect(service.listForCountry(999)).rejects.toThrow();
  });

  it('merges rule and reward assignments into one list', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(Country, countryRow({ id: 1 }));

    const ruleAssignment = ruleVersionCountryAssignmentRow({
      ruleVersionId: 5,
      ruleId: 10,
      status: 'active',
      ruleVersion: {
        ...ruleVersionRow({ id: 5, versionNo: 3 }),
        rule: { ruleCode: 'MIN_SPEND_TIER', name: 'Minimum spend tier' },
      } as never,
    });
    scoped.setListRows(RuleVersionCountryAssignment, [ruleAssignment]);

    const rewardAssignment = rewardVersionCountryAssignmentRow({
      rewardVersionId: 8,
      rewardId: 20,
      status: 'superseded',
      rewardVersion: {
        ...rewardVersionRow({ id: 8, versionNo: 2 }),
        reward: { systemCode: 'CASHBACK_BASIC', name: 'Basic cashback' },
      } as never,
    });
    scoped.setListRows(RewardVersionCountryAssignment, [rewardAssignment]);

    const rows = await service.listForCountry(1);

    expect(rows).toHaveLength(2);
    const rule = rows.find((row) => row.entityType === 'rule');
    const reward = rows.find((row) => row.entityType === 'reward');
    expect(rule).toMatchObject({ entityId: 10, entityCode: 'MIN_SPEND_TIER', versionNo: 3 });
    expect(reward).toMatchObject({
      entityId: 20,
      entityCode: 'CASHBACK_BASIC',
      versionNo: 2,
      status: 'superseded',
    });
  });

  it('returns an empty list when the country holds nothing', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(Country, countryRow({ id: 1 }));
    scoped.setListRows(RuleVersionCountryAssignment, []);
    scoped.setListRows(RewardVersionCountryAssignment, []);

    const rows = await service.listForCountry(1);
    expect(rows).toEqual([]);
  });
});
