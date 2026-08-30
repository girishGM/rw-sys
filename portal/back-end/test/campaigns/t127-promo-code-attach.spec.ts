/**
 * T-127 — the **server side** of the Promo Code attach flow: the two Kind-dependent gates on
 * `POST /campaigns/:id/rewards`, the `config` write they guard, and the two fields step 5's picker
 * reads off `GET /campaigns/:id/reward-options`.
 *
 * ### Why these are tested here and not only through the SPA
 *
 * `RewardsStep.test.tsx` proves the picker never *offers* an attachment the server would refuse.
 * That is a usability property, not a control: `POST /campaigns/:id/rewards` is an ordinary HTTP
 * endpoint and a `curl` reaches it without ever loading the SPA. Every case below is written from
 * the position of a caller who skipped the UI entirely — which is the only position from which the
 * gate is worth anything (T-037 implementation note 9's standing rule for this module: *"client-
 * built validation is trivially bypassed"*).
 *
 * ### What is faked, and what deliberately is not
 *
 * The repository is faked; **no decision is**. `promoCodeBindLevels()` parses `value_config` with
 * the real shared `promoCodeValueConfigSchema`, so "which levels did the author allow" is answered
 * here by exactly the code that answers it in production — a hand-rolled fake of that parse would
 * be a test of the fake. What the doubles stand in for is Postgres returning rows, which T-013
 * already proves exhaustively and which these cases are not about.
 */
import type {
  CreateOptions,
  FindOptions,
  Model,
  ModelStatic,
  Transaction,
  UpdateOptions,
} from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type { CampaignAuditService } from '@/modules/campaigns/campaign-audit.service';
import type { TenantCampaign } from '@/database/models';
import {
  RewardCampaignAssignment,
  RewardComponentAssignment,
  RewardPolicy,
  RewardSystem,
  RewardTrackerAssignment,
  RewardVersion,
  RewardVersionCountryAssignment,
  TenantCampaignTracker,
  TrackerTrackerComponent,
} from '@/database/models';
import { BindingsService } from '@/modules/campaigns/bindings.service';
import {
  PromoCodeConfigNotApplicableError,
  RewardNotAttachableAtLevelError,
} from '@/modules/campaigns/campaigns.errors';
import type { AttachRewardDto } from '@/modules/campaigns/dto/binding.dto';

// --- doubles -------------------------------------------------------------------------------------

interface RecordedUpdate {
  readonly model: string;
  readonly values: Record<string, unknown>;
  readonly options: UpdateOptions;
}

/**
 * Answers `listAll` from a per-model script and records every `update`.
 *
 * `create` returns a row with an id, because `attachReward` returns it and a test that could not
 * tell a successful attach from a failed one would prove nothing about the gates.
 */
class FakeScoped {
  readonly updates: RecordedUpdate[] = [];
  readonly created: { model: string; values: Record<string, unknown> }[] = [];
  private readonly rows = new Map<string, unknown[]>();

  setRows(model: ModelStatic<Model>, rows: readonly unknown[]): this {
    this.rows.set(model.name, [...rows]);
    return this;
  }

  async listAll<M extends Model>(model: ModelStatic<M>, _options: FindOptions = {}): Promise<M[]> {
    return (this.rows.get(model.name) ?? []) as M[];
  }

  async create<M extends Model>(
    model: ModelStatic<M>,
    values: unknown,
    _options: CreateOptions = {},
  ): Promise<M> {
    this.created.push({ model: model.name, values: values as Record<string, unknown> });
    return { id: 9001, ...(values as object) } as unknown as M;
  }

  async update(
    model: ModelStatic<Model>,
    values: unknown,
    options: UpdateOptions,
  ): Promise<number> {
    this.updates.push({
      model: model.name,
      values: values as Record<string, unknown>,
      options,
    });
    return 1;
  }
}

class FakeSequelize {
  async transaction<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> {
    return fn({} as Transaction);
  }
}

class FakeAudit {
  readonly events: Record<string, unknown>[] = [];
  async record(_actor: unknown, event: Record<string, unknown>): Promise<void> {
    this.events.push(event);
  }
}

// --- fixtures ------------------------------------------------------------------------------------

const MAKER = {
  id: 1,
  role: 'maker',
  tenantId: 10,
  countryId: 20,
  merchantId: null,
} as unknown as AuthenticatedUser;

const CAMPAIGN = { id: 500, tenantId: 10 } as unknown as TenantCampaign;

/**
 * A `reward_policies` row, plus the updates performed **on the row itself**.
 *
 * `writePromoCodeConfig` persists through the instance `resolveRewardPolicy` loaded (see its
 * header: `ScopedRepository.update` cannot be used on a `subquery`-scoped model by a non-Super
 * Admin), so the double has to be a row that can be written to — not a plain object. Everything
 * the double records is what Sequelize would send: the values, against this row's own primary key.
 */
interface PolicyRow {
  readonly row: RewardPolicy;
  readonly updates: Record<string, unknown>[];
}

function policyRow(config: Record<string, unknown> = {}): PolicyRow {
  const updates: Record<string, unknown>[] = [];
  const row = {
    id: 22,
    rewardSystemId: 2,
    policyCode: 'POL_PROMO',
    name: 'Raya promo',
    status: 'active',
    config,
    update: async (values: Record<string, unknown>): Promise<void> => {
      updates.push(values);
    },
  } as unknown as RewardPolicy;
  return { row, updates };
}

/** A reward version of some `kind`, with whatever `value_config` the case needs. */
function version(
  id: number,
  rewardKind: string | null,
  valueConfig: Record<string, unknown> | null,
): RewardVersion {
  return {
    id,
    rewardKind,
    valueConfig,
    unitType: null,
    unitCode: null,
  } as unknown as RewardVersion;
}

function promoVersion(bindLevels: readonly string[]): RewardVersion {
  return version(202, 'PROMO_CODE', {
    apiProvider: 'PROMO_CODE_CONFIG_SERVICE',
    bindLevels: [...bindLevels],
  });
}

interface Wiring {
  readonly policy?: PolicyRow;
  readonly version?: RewardVersion | null;
}

function build({ policy = policyRow(), version: live = promoVersion(['campaign']) }: Wiring = {}) {
  const scoped = new FakeScoped();
  const audit = new FakeAudit();

  // `resolveRewardPolicy` reads the policy by id, and `activeRewardVersionsByReward` joins the
  // reward's country assignments to its versions — both go through `listAll`.
  scoped.setRows(RewardPolicy, [policy.row]);
  scoped.setRows(RewardSystem, [
    { id: policy.row.rewardSystemId, name: 'Promo code', rewardType: 'voucher' },
  ]);
  scoped.setRows(
    RewardVersionCountryAssignment,
    live === null
      ? []
      : [{ rewardId: policy.row.rewardSystemId, rewardVersionId: live.id, status: 'active' }],
  );
  scoped.setRows(RewardVersion, live === null ? [] : [live]);

  // Membership comes first in `attachReward`: a tracker- or component-level attach is refused with
  // `NotPartOfCampaignError` before any Kind gate runs (T-037's `assertTrackerInCampaign` /
  // `assertComponentInCampaign`). These two rows make tracker 7 and component 71 — the ids the
  // cases below attach to — genuinely part of CAMPAIGN, so what those cases observe is the promo
  // code gate and not a membership refusal. Membership itself is T-013/T-037's to prove, and is
  // deliberately not re-tested here.
  scoped.setRows(TenantCampaignTracker, [
    { id: 30, campaignId: CAMPAIGN.id, trackerId: 7, status: 'active' },
  ]);
  scoped.setRows(TrackerTrackerComponent, [
    { id: 40, trackerId: 7, componentId: 71, sequenceOrder: 1 },
  ]);

  const service = new BindingsService(
    new FakeSequelize() as unknown as Sequelize,
    scoped as unknown as ScopedRepository,
    audit as unknown as CampaignAuditService,
  );
  return { service, scoped, audit, policy };
}

function attach(overrides: Partial<AttachRewardDto> = {}): AttachRewardDto {
  return { level: 'campaign', rewardPolicyId: 22, ...overrides } as AttachRewardDto;
}

/** The `config` a policy was updated to, or `undefined` if it was never written. */
function writtenConfig(policy: PolicyRow): Record<string, unknown> | undefined {
  return policy.updates[0]?.['config'] as Record<string, unknown> | undefined;
}

// --- the bind-level gate -------------------------------------------------------------------------

describe('T-127 · attaching a PROMO_CODE reward — the bind-level gate', () => {
  it('TC-3: attaches at a level the author allowed', async () => {
    const { service, scoped } = build({ version: promoVersion(['campaign']) });

    const id = await service.attachReward(MAKER, CAMPAIGN, attach({ level: 'campaign' }));

    expect(id).toBe(9001);
    expect(scoped.created.map((row) => row.model)).toEqual([RewardCampaignAssignment.name]);
  });

  it('TC-4: the same reward attaches at component level when the author allowed that too', async () => {
    const { service, scoped } = build({ version: promoVersion(['component', 'campaign']) });

    await service.attachReward(MAKER, CAMPAIGN, attach({ level: 'component', refId: 71 }));

    expect(scoped.created.map((row) => row.model)).toEqual([RewardComponentAssignment.name]);
  });

  it('refuses a level the author excluded, and writes nothing — a curl gets the same answer as the SPA', async () => {
    const { service, scoped, policy } = build({ version: promoVersion(['component']) });

    await expect(
      service.attachReward(MAKER, CAMPAIGN, attach({ level: 'campaign' })),
    ).rejects.toBeInstanceOf(RewardNotAttachableAtLevelError);

    // The gate runs *before* the insert, so a refused attach leaves no assignment behind.
    expect(scoped.created).toEqual([]);
    expect(scoped.updates).toEqual([]);
    expect(policy.updates).toEqual([]);
  });

  it('refuses at tracker level too, when only component was allowed', async () => {
    const { service } = build({ version: promoVersion(['component']) });

    await expect(
      service.attachReward(MAKER, CAMPAIGN, attach({ level: 'tracker', refId: 7 })),
    ).rejects.toBeInstanceOf(RewardNotAttachableAtLevelError);
  });

  it('reports the refusal as a 400 naming the level, not a 404 that hides what went wrong', async () => {
    const { service } = build({ version: promoVersion(['component']) });

    const error: unknown = await service
      .attachReward(MAKER, CAMPAIGN, attach({ level: 'campaign' }))
      .catch((caught: unknown) => caught);

    // Asserted on the wire-visible outcome, not on the class name: a maker who cannot attach here
    // needs to be told *which* thing they cannot do, or they cannot fix it.
    expect(error).toBeInstanceOf(RewardNotAttachableAtLevelError);
    const refusal = error as RewardNotAttachableAtLevelError;
    expect(refusal.status).toBe(400);
    expect(refusal.code).toBe('REWARD_NOT_ATTACHABLE_AT_LEVEL');
    expect(refusal.details).toEqual([{ field: 'level', code: 'LEVEL_CAMPAIGN' }]);
  });

  it('allows every level when the version states no parseable restriction — permissive by design', async () => {
    // A `PROMO_CODE` version whose `value_config` is malformed (or predates T-119's validation).
    // Refusing every attach would break a maker's campaign over a field they never filled in; see
    // `promoCodeBindLevels`'s own comment for why this is deliberate rather than an oversight.
    const { service, scoped } = build({ version: version(202, 'PROMO_CODE', { junk: true }) });

    await service.attachReward(MAKER, CAMPAIGN, attach({ level: 'tracker', refId: 7 }));

    expect(scoped.created.map((row) => row.model)).toEqual([RewardTrackerAssignment.name]);
  });

  it('TC-6: a non-PROMO_CODE reward is not gated at any level', async () => {
    const { service, scoped, policy } = build({
      version: version(101, 'FIXED_AMOUNT', {
        multiCurrency: false,
        defaultCurrency: 'MYR',
        defaultValue: 10,
      }),
    });

    await service.attachReward(MAKER, CAMPAIGN, attach({ level: 'campaign' }));

    expect(scoped.created).toHaveLength(1);
    expect(writtenConfig(policy)).toBeUndefined();
  });

  it('a reward with no live version at all is not gated — that is every reward authored before T-119', async () => {
    const { service, scoped } = build({ version: null });

    await service.attachReward(MAKER, CAMPAIGN, attach({ level: 'campaign' }));

    expect(scoped.created).toHaveLength(1);
  });
});

// --- the config write ----------------------------------------------------------------------------

describe('T-127 · storing the maker’s Promo Code Config', () => {
  it('writes the pick into the attached policy’s own config JSON (§5: no new column)', async () => {
    const { service, policy } = build({ version: promoVersion(['campaign']) });

    await service.attachReward(MAKER, CAMPAIGN, attach({ promoCodeConfig: 'RAYA_2026' }));

    expect(writtenConfig(policy)).toEqual({ promoCodeConfig: 'RAYA_2026' });
    // Written on the row the scoped read returned — one update, on that policy and no other.
    expect(policy.updates).toHaveLength(1);
  });

  it('merges into the existing config rather than replacing it — an unrelated key survives', async () => {
    // `config` is free-form and already carries whatever the reward author put there;
    // `readPolicyAmount` reads `amount` straight back out of it for the worst-case payout line.
    // A blind overwrite here would silently zero that out.
    const policy = policyRow({ amount: '10.00', notes: 'author supplied' });
    const { service } = build({ policy, version: promoVersion(['campaign']) });

    await service.attachReward(MAKER, CAMPAIGN, attach({ promoCodeConfig: 'RAYA_2026' }));

    expect(writtenConfig(policy)).toEqual({
      amount: '10.00',
      notes: 'author supplied',
      promoCodeConfig: 'RAYA_2026',
    });
  });

  it('Verification step 2: attaching with nothing picked leaves the config structurally untouched', async () => {
    // The normal path today — `PROMO_CODE_CONFIG_SERVICE` is `planned`, so there is nothing to
    // pick. The attach must still succeed, and must not write a `promoCodeConfig: null` that a
    // later reader would have to special-case.
    const { service, policy } = build({ version: promoVersion(['campaign']) });

    const id = await service.attachReward(MAKER, CAMPAIGN, attach());

    expect(id).toBe(9001);
    expect(policy.updates).toEqual([]);
  });

  it('rejects a config sent for a reward that is not PROMO_CODE, rather than silently dropping it', async () => {
    const { service, scoped, policy } = build({
      version: version(101, 'FIXED_AMOUNT', {
        multiCurrency: false,
        defaultCurrency: 'MYR',
        defaultValue: 10,
      }),
    });

    const error: unknown = await service
      .attachReward(MAKER, CAMPAIGN, attach({ promoCodeConfig: 'RAYA_2026' }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PromoCodeConfigNotApplicableError);
    const refusal = error as PromoCodeConfigNotApplicableError;
    expect(refusal.status).toBe(400);
    expect(refusal.code).toBe('PROMO_CODE_CONFIG_NOT_APPLICABLE');
    expect(scoped.created).toEqual([]);
    expect(scoped.updates).toEqual([]);
    expect(policy.updates).toEqual([]);
  });

  it('records the config in the audit trail when supplied, and changes nothing when not', async () => {
    const { service: withConfig, audit: auditWith } = build({
      version: promoVersion(['campaign']),
    });
    await withConfig.attachReward(MAKER, CAMPAIGN, attach({ promoCodeConfig: 'RAYA_2026' }));

    const { service: without, audit: auditWithout } = build({
      version: promoVersion(['campaign']),
    });
    await without.attachReward(MAKER, CAMPAIGN, attach());

    expect(auditWith.events[0]?.['fieldChanges']).toEqual({
      level: 'campaign',
      refId: null,
      rewardPolicyId: 22,
      promoCodeConfig: 'RAYA_2026',
    });
    // TC-6's other half: the ordinary attach's audit row is byte-for-byte what T-037 wrote.
    expect(auditWithout.events[0]?.['fieldChanges']).toEqual({
      level: 'campaign',
      refId: null,
      rewardPolicyId: 22,
    });
  });
});

// --- what step 5 reads ---------------------------------------------------------------------------

describe('T-127 · GET /campaigns/:id/reward-options carries the Kind and its bind levels', () => {
  it('publishes rewardKind and promoCodeBindLevels for a PROMO_CODE reward', async () => {
    const { service } = build({ version: promoVersion(['component', 'campaign']) });

    const [option] = await service.listRewardOptions();

    expect(option?.rewardKind).toBe('PROMO_CODE');
    // Exactly what the author ticked — the picker filters levels on this and nothing else.
    expect(option?.promoCodeBindLevels).toEqual(['component', 'campaign']);
  });

  it('TC-6: reports null for both on a reward of any other Kind, so no promo UI can render', async () => {
    const { service } = build({
      version: version(101, 'FIXED_AMOUNT', {
        multiCurrency: false,
        defaultCurrency: 'MYR',
        defaultValue: 10,
      }),
    });

    const [option] = await service.listRewardOptions();

    expect(option?.rewardKind).toBe('FIXED_AMOUNT');
    expect(option?.promoCodeBindLevels).toBeNull();
  });

  it('reports null bind levels for an unparseable PROMO_CODE config — the same "no restriction" the gate applies', async () => {
    // The client and the server must read this identically, or the picker offers what the server
    // refuses (or hides what it would have accepted). This case is that agreement, asserted.
    const { service } = build({ version: version(202, 'PROMO_CODE', { junk: true }) });

    const [option] = await service.listRewardOptions();

    expect(option?.rewardKind).toBe('PROMO_CODE');
    expect(option?.promoCodeBindLevels).toBeNull();
  });

  it('reports null for a reward with no live version, without failing the whole list', async () => {
    const { service } = build({ version: null });

    const [option] = await service.listRewardOptions();

    expect(option?.rewardKind).toBeNull();
    expect(option?.promoCodeBindLevels).toBeNull();
    expect(option?.rewardVersionId).toBeNull();
  });
});
