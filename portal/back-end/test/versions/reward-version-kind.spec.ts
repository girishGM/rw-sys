/**
 * T-119 — `RewardVersionsService`'s half of the reward `Kind`/`value_config` pair
 * (13-REWARD-MASTER-VALUE-SOURCES.md §5): what the create/update paths accept, what they refuse
 * with a 400, and what comes back on the wire.
 *
 * A separate file from `reward-versions.service.spec.ts` (T-041's, still owned by that task and
 * currently being extended by T-109's sibling work on the rule side) rather than extra `describe`
 * blocks inside it — same reasoning `T103_002` gives for a new migration instead of an edit to
 * `T005_007`: additive beats editing a file another task owns.
 *
 * What is deliberately **not** here: TC-6, the immutability of a published version's Kind. That is
 * a database guarantee (`fn_reward_version_immutable`), and a unit test with a fake repository
 * could only prove that this service asks nicely. It is proven against real Postgres in
 * `test/database/t119-reward-version-kind.e2e-spec.ts`.
 */
import { REWARD_KINDS } from '@reward-portal/shared';
import { ValidationFailedError } from '@/common/errors/app-error';
import { RewardSystem, RewardVersion } from '@/database/models';
import { REWARD_VERSION_KINDS } from '@/database/models/reward-version.model';
import { PortalUser } from '@/database/portal-models';
import { RewardVersionsService } from '@/modules/versions/reward-versions.service';
import {
  FakeAuditService,
  FakeScopedRepository,
  FakeSequelize,
  actor,
  asAuditService,
  asScopedRepository,
  asSequelize,
  portalUserRow,
  rewardRow,
  rewardVersionRow,
} from './support/versions-doubles';

const MULTI_CURRENCY_CONFIG = {
  multiCurrency: true,
  currencyValues: [
    { currency: 'MYR', value: 10 },
    { currency: 'SGD', value: 3.5 },
  ],
};

function buildService() {
  const scoped = new FakeScopedRepository();
  const audit = new FakeAuditService();
  scoped.setByPk(PortalUser, portalUserRow());
  const service = new RewardVersionsService(
    asSequelize(new FakeSequelize()),
    asScopedRepository(scoped),
    asAuditService(audit),
  );
  return { service, scoped, audit };
}

/** A service primed to create the very first version of a reward (no published predecessor). */
function buildForCreate() {
  const built = buildService();
  built.scoped.setByPk(RewardSystem, rewardRow());
  built.scoped.setCount(RewardVersion, 0);
  built.scoped.pushListRows(RewardVersion, []);
  built.scoped.pushListRows(RewardVersion, []);
  return built;
}

describe('the Kind vocabulary is written down once', () => {
  it('the model tuple and the shared wire enum name the same five Kinds', () => {
    expect([...REWARD_VERSION_KINDS]).toEqual([...REWARD_KINDS]);
  });
});

describe('RewardVersionsService.createDraft — Kind and value config', () => {
  it('TC-1 — creates a FIXED_AMOUNT draft with two currencies', async () => {
    const { service, scoped } = buildForCreate();

    const dto = await service.createDraft(actor(), 1, {
      rewardKind: 'FIXED_AMOUNT',
      valueConfig: MULTI_CURRENCY_CONFIG,
    });

    expect(dto.rewardKind).toBe('FIXED_AMOUNT');
    expect(dto.valueConfig).toEqual(MULTI_CURRENCY_CONFIG);
    const [created] = scoped.callsTo('create');
    expect(created.values).toMatchObject({
      rewardKind: 'FIXED_AMOUNT',
      valueConfig: MULTI_CURRENCY_CONFIG,
    });
  });

  it('TC-2 — refuses multiCurrency: true with an empty currencyValues, and writes nothing', async () => {
    const { service, scoped } = buildForCreate();

    await expect(
      service.createDraft(actor(), 1, {
        rewardKind: 'FIXED_AMOUNT',
        valueConfig: { multiCurrency: true, currencyValues: [] },
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect(scoped.callsTo('create')).toHaveLength(0);
  });

  it('TC-3 — refuses PERCENTAGE with percentage: 150', async () => {
    const { service } = buildForCreate();
    await expect(
      service.createDraft(actor(), 1, {
        rewardKind: 'PERCENTAGE',
        valueConfig: { percentage: 150 },
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('TC-4 — refuses PROMO_CODE with an empty bindLevels', async () => {
    const { service } = buildForCreate();
    await expect(
      service.createDraft(actor(), 1, {
        rewardKind: 'PROMO_CODE',
        valueConfig: { apiProvider: 'PROMO_CODE_CONFIG_SERVICE', bindLevels: [] },
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('TC-5 — accepts PROMO_CODE against the planned PROMO_CODE_CONFIG_SERVICE provider', async () => {
    const { service } = buildForCreate();

    const dto = await service.createDraft(actor(), 1, {
      rewardKind: 'PROMO_CODE',
      valueConfig: {
        apiProvider: 'PROMO_CODE_CONFIG_SERVICE',
        bindLevels: ['component', 'tracker', 'campaign'],
      },
    });

    expect(dto.rewardKind).toBe('PROMO_CODE');
  });

  it('refuses a value config with no Kind, naming rewardKind as the offending field', async () => {
    const { service } = buildForCreate();

    await expect(
      service.createDraft(actor(), 1, { valueConfig: { percentage: 10 } }),
    ).rejects.toMatchObject({
      status: 400,
      details: [{ field: 'rewardKind', code: 'INVALID_REWARD_VALUE_CONFIG' }],
    });
  });

  it('names valueConfig as the offending field when the Kind is the valid half', async () => {
    const { service } = buildForCreate();

    await expect(
      service.createDraft(actor(), 1, { rewardKind: 'POINTS', valueConfig: { points: -1 } }),
    ).rejects.toMatchObject({ details: [{ field: 'valueConfig' }] });
  });

  it('TC-7 — bootstraps v1 with no Kind at all when none is supplied', async () => {
    const { service } = buildForCreate();

    const dto = await service.createDraft(actor(), 1, {});

    expect(dto.rewardKind).toBeNull();
    expect(dto.valueConfig).toBeNull();
  });

  it('clones the latest published version’s Kind into the new draft', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardRow());
    scoped.setCount(RewardVersion, 0);
    const published = rewardVersionRow({
      id: 1,
      versionNo: 1,
      status: 'published',
      rewardKind: 'POINTS',
      valueConfig: { points: 500 },
    });
    scoped.pushListRows(RewardVersion, [published]);
    scoped.pushListRows(RewardVersion, [published]);

    const dto = await service.createDraft(actor(), 1, {});

    expect(dto.rewardKind).toBe('POINTS');
    expect(dto.valueConfig).toEqual({ points: 500 });
  });

  it('a supplied Kind overrides the cloned one', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardRow());
    scoped.setCount(RewardVersion, 0);
    const published = rewardVersionRow({
      id: 1,
      versionNo: 1,
      status: 'published',
      rewardKind: 'POINTS',
      valueConfig: { points: 500 },
    });
    scoped.pushListRows(RewardVersion, [published]);
    scoped.pushListRows(RewardVersion, [published]);

    const dto = await service.createDraft(actor(), 1, {
      rewardKind: 'PERCENTAGE',
      valueConfig: { percentage: 5 },
    });

    expect(dto.rewardKind).toBe('PERCENTAGE');
    expect(dto.valueConfig).toEqual({ percentage: 5 });
  });
});

describe('RewardVersionsService.updateDraft — Kind and value config', () => {
  it('writes both halves when both are supplied', async () => {
    const { service, scoped } = buildService();
    scoped.pushByPk(RewardVersion, rewardVersionRow({ id: 1, status: 'draft' }));
    scoped.pushByPk(
      RewardVersion,
      rewardVersionRow({
        id: 1,
        status: 'draft',
        rewardKind: 'PHYSICAL',
        valueConfig: { sku: 'MUG-001', description: 'Branded mug' },
      }),
    );

    const dto = await service.updateDraft(actor(), 1, 1, {
      rewardKind: 'PHYSICAL',
      valueConfig: { sku: 'MUG-001', description: 'Branded mug' },
    });

    expect(dto.rewardKind).toBe('PHYSICAL');
    const [call] = scoped.callsTo('update');
    expect(call.values).toEqual({
      rewardKind: 'PHYSICAL',
      valueConfig: { sku: 'MUG-001', description: 'Branded mug' },
    });
  });

  it('validates a config-only PATCH against the Kind already stored on the draft', async () => {
    const { service, scoped } = buildService();
    scoped.pushByPk(
      RewardVersion,
      rewardVersionRow({ id: 1, status: 'draft', rewardKind: 'PERCENTAGE' }),
    );
    scoped.pushByPk(
      RewardVersion,
      rewardVersionRow({
        id: 1,
        status: 'draft',
        rewardKind: 'PERCENTAGE',
        valueConfig: { percentage: 12.5 },
      }),
    );

    const dto = await service.updateDraft(actor(), 1, 1, { valueConfig: { percentage: 12.5 } });

    expect(dto.valueConfig).toEqual({ percentage: 12.5 });
  });

  it('refuses a config-only PATCH that contradicts the stored Kind', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(
      RewardVersion,
      rewardVersionRow({ id: 1, status: 'draft', rewardKind: 'PERCENTAGE' }),
    );

    await expect(
      service.updateDraft(actor(), 1, 1, { valueConfig: { points: 500 } }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect(scoped.callsTo('update')).toHaveLength(0);
  });

  it('refuses a Kind-only PATCH that contradicts the stored config', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(
      RewardVersion,
      rewardVersionRow({
        id: 1,
        status: 'draft',
        rewardKind: 'PERCENTAGE',
        valueConfig: { percentage: 10 },
      }),
    );

    await expect(
      service.updateDraft(actor(), 1, 1, { rewardKind: 'POINTS' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect(scoped.callsTo('update')).toHaveLength(0);
  });

  it('lets a draft clear both halves back to null', async () => {
    const { service, scoped } = buildService();
    scoped.pushByPk(
      RewardVersion,
      rewardVersionRow({
        id: 1,
        status: 'draft',
        rewardKind: 'POINTS',
        valueConfig: { points: 1 },
      }),
    );
    scoped.pushByPk(
      RewardVersion,
      // `rewardVersionRow()` predates T-119 and omits both keys (it belongs to T-041), so the
      // cleared state is spelled out here rather than by editing another task's fixture.
      rewardVersionRow({ id: 1, status: 'draft', rewardKind: null, valueConfig: null }),
    );

    const dto = await service.updateDraft(actor(), 1, 1, { rewardKind: null, valueConfig: null });

    expect(dto.rewardKind).toBeNull();
    const [call] = scoped.callsTo('update');
    expect(call.values).toEqual({ rewardKind: null, valueConfig: null });
  });

  it('leaves the pair untouched when neither half is in the request', async () => {
    const { service, scoped } = buildService();
    scoped.pushByPk(
      RewardVersion,
      rewardVersionRow({ id: 1, status: 'draft', rewardKind: 'POINTS' }),
    );
    scoped.pushByPk(
      RewardVersion,
      rewardVersionRow({ id: 1, status: 'draft', rewardKind: 'POINTS', deliveryMode: 'batch' }),
    );

    await service.updateDraft(actor(), 1, 1, { deliveryMode: 'batch' });

    const [call] = scoped.callsTo('update');
    expect(call.values).toEqual({ deliveryMode: 'batch' });
  });

  it('audits a Kind change like any other payload change', async () => {
    const { service, scoped, audit } = buildService();
    scoped.pushByPk(
      RewardVersion,
      rewardVersionRow({ id: 1, status: 'draft', rewardKind: null, valueConfig: null }),
    );
    scoped.pushByPk(
      RewardVersion,
      rewardVersionRow({ id: 1, status: 'draft', rewardKind: 'POINTS' }),
    );

    await service.updateDraft(actor(), 1, 1, { rewardKind: 'POINTS' });

    const [diffed] = audit.diffFieldsCalls;
    expect(diffed.before.rewardKind).toBeNull();
    expect(diffed.after.rewardKind).toBe('POINTS');
  });
});

describe('every reward-version read carries the pair', () => {
  it('list() and getById() both return rewardKind/valueConfig', async () => {
    const { service, scoped } = buildService();
    scoped.setByPk(RewardSystem, rewardRow());
    const row = rewardVersionRow({
      id: 2,
      versionNo: 2,
      rewardKind: 'FIXED_AMOUNT',
      valueConfig: MULTI_CURRENCY_CONFIG,
    });
    scoped.setListRows(RewardVersion, [row]);
    scoped.setByPk(RewardVersion, row);

    const [listed] = await service.list(1);
    const fetched = await service.getById(1, 2);

    expect(listed.rewardKind).toBe('FIXED_AMOUNT');
    expect(listed.valueConfig).toEqual(MULTI_CURRENCY_CONFIG);
    expect(fetched.valueConfig).toEqual(MULTI_CURRENCY_CONFIG);
  });

  it('TC-7 — a pre-T-119 row reads back with both halves null, no error', async () => {
    const { service, scoped } = buildService();
    const row = rewardVersionRow({ id: 3, rewardKind: null, valueConfig: null });
    scoped.setByPk(RewardVersion, row);

    const dto = await service.getById(1, 3);

    expect(dto.rewardKind).toBeNull();
    expect(dto.valueConfig).toBeNull();
  });

  it('publish/deprecate/retire responses carry the pair too', async () => {
    const { service, scoped } = buildService();
    scoped.pushByPk(
      RewardVersion,
      rewardVersionRow({
        id: 4,
        status: 'draft',
        rewardKind: 'POINTS',
        valueConfig: { points: 7 },
      }),
    );
    scoped.pushByPk(
      RewardVersion,
      rewardVersionRow({
        id: 4,
        status: 'published',
        rewardKind: 'POINTS',
        valueConfig: { points: 7 },
      }),
    );

    const dto = await service.publish(actor(), 1, 4);

    expect(dto.status).toBe('published');
    expect(dto.valueConfig).toEqual({ points: 7 });
  });
});
