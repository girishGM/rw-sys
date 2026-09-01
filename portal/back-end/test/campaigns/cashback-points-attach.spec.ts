/**
 * Ad hoc (no registered task — see `task/reset-reference-data-keep-users`) — the cashback/points
 * siblings of T-127's Promo Code attach flow: `BindingsService.attachReward`'s Kind-dependent
 * gates and `config` writes for `FIXED_AMOUNT`/`POINTS` rewards left with no `value_config` at
 * creation time, mirroring `t127-promo-code-attach.spec.ts` structure and doubles exactly — see
 * that file's own header for why these are tested from the position of a caller who skipped the
 * SPA entirely, and why the repository is faked but no decision is.
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
import type { PromoCodeServiceClient } from '@/modules/promo-code-integration/promo-code-service.client';
import type { TenantCampaign } from '@/database/models';
import {
  RewardCampaignAssignment,
  RewardPolicy,
  RewardSystem,
  RewardVersion,
  RewardVersionCountryAssignment,
} from '@/database/models';
import { BindingsService } from '@/modules/campaigns/bindings.service';
import {
  CashbackAmountNotApplicableError,
  PointsNotApplicableError,
} from '@/modules/campaigns/campaigns.errors';
import type { AttachRewardDto } from '@/modules/campaigns/dto/binding.dto';

// --- doubles (mirrors t127-promo-code-attach.spec.ts) -------------------------------------------

class FakeScoped {
  readonly updates: Record<string, unknown>[] = [];
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
    this.updates.push(values as Record<string, unknown>);
    void options;
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

const MAKER = {
  id: 1,
  role: 'maker',
  tenantId: 10,
  countryId: 20,
  merchantId: null,
} as unknown as AuthenticatedUser;

const CAMPAIGN = { id: 500, tenantId: 10 } as unknown as TenantCampaign;

interface PolicyRow {
  readonly row: RewardPolicy;
  readonly updates: Record<string, unknown>[];
}

function policyRow(config: Record<string, unknown> = {}): PolicyRow {
  const updates: Record<string, unknown>[] = [];
  const row = {
    id: 22,
    rewardSystemId: 2,
    policyCode: 'POL_CASH',
    name: 'Signup cashback',
    status: 'active',
    config,
    update: async (values: Record<string, unknown>): Promise<void> => {
      updates.push(values);
    },
  } as unknown as RewardPolicy;
  return { row, updates };
}

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

/** A `FIXED_AMOUNT` version whose author left no `value_config` — the case this feature exists
 * for: the Maker supplies the amount at attach time instead. */
const CASHBACK_VERSION = version(301, 'FIXED_AMOUNT', null);
/** A `POINTS` version left unset the same way. */
const POINTS_VERSION = version(302, 'POINTS', null);

interface Wiring {
  readonly policy?: PolicyRow;
  readonly version?: RewardVersion | null;
}

function build({ policy = policyRow(), version: live = CASHBACK_VERSION }: Wiring = {}) {
  const scoped = new FakeScoped();
  const audit = new FakeAudit();

  scoped.setRows(RewardPolicy, [policy.row]);
  scoped.setRows(RewardSystem, [
    { id: policy.row.rewardSystemId, name: 'Cashback', rewardType: 'cashback' },
  ]);
  scoped.setRows(
    RewardVersionCountryAssignment,
    live === null
      ? []
      : [{ rewardId: policy.row.rewardSystemId, rewardVersionId: live.id, status: 'active' }],
  );
  scoped.setRows(RewardVersion, live === null ? [] : [live]);

  const service = new BindingsService(
    new FakeSequelize() as unknown as Sequelize,
    scoped as unknown as ScopedRepository,
    audit as unknown as CampaignAuditService,
    // T-166 — no path exercised in this file supplies a `promoCodeConfig`, so none of them may
    // reach promo-code-service. A double that throws states that as an assertion rather than
    // leaving it to be noticed: if an attach here ever starts binding, this file fails loudly.
    {
      bind: (): Promise<never> =>
        Promise.reject(new Error('T-166: no promo-code-service bind is expected on this path')),
    } as unknown as PromoCodeServiceClient,
  );
  return { service, scoped, audit, policy };
}

function attach(overrides: Partial<AttachRewardDto> = {}): AttachRewardDto {
  return { level: 'campaign', rewardPolicyId: 22, ...overrides } as AttachRewardDto;
}

function writtenConfig(policy: PolicyRow): Record<string, unknown> | undefined {
  return policy.updates[0]?.['config'] as Record<string, unknown> | undefined;
}

// --- cashback --------------------------------------------------------------------------------

describe('cashback attach — the FIXED_AMOUNT gate and config write', () => {
  it('writes the amount and currency into the attached policy’s own config JSON', async () => {
    const { service, policy } = build({ version: CASHBACK_VERSION });

    await service.attachReward(
      MAKER,
      CAMPAIGN,
      attach({ cashbackAmount: '25.50', cashbackCurrency: 'MYR' }),
    );

    expect(writtenConfig(policy)).toEqual({ amount: '25.50', currency: 'MYR' });
    expect(policy.updates).toHaveLength(1);
  });

  it('merges into the existing config rather than replacing it', async () => {
    const policy = policyRow({ notes: 'author supplied' });
    const { service } = build({ policy, version: CASHBACK_VERSION });

    await service.attachReward(
      MAKER,
      CAMPAIGN,
      attach({ cashbackAmount: '25.50', cashbackCurrency: 'MYR' }),
    );

    expect(writtenConfig(policy)).toEqual({
      notes: 'author supplied',
      amount: '25.50',
      currency: 'MYR',
    });
  });

  it('attaching with nothing supplied leaves the config untouched — the gate is permissive, matching promo code', async () => {
    const { service, policy } = build({ version: CASHBACK_VERSION });

    const id = await service.attachReward(MAKER, CAMPAIGN, attach());

    expect(id).toBe(9001);
    expect(policy.updates).toEqual([]);
  });

  it('rejects a cashback amount sent for a reward that is not FIXED_AMOUNT, rather than silently dropping it', async () => {
    const { service, scoped, policy } = build({ version: POINTS_VERSION });

    const error: unknown = await service
      .attachReward(MAKER, CAMPAIGN, attach({ cashbackAmount: '25.50', cashbackCurrency: 'MYR' }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CashbackAmountNotApplicableError);
    const refusal = error as CashbackAmountNotApplicableError;
    expect(refusal.status).toBe(400);
    expect(refusal.code).toBe('CASHBACK_AMOUNT_NOT_APPLICABLE');
    // The gate runs before the insert — a refused attach leaves no assignment behind.
    expect(scoped.created).toEqual([]);
    expect(policy.updates).toEqual([]);
  });

  it('records the amount and currency in the audit trail when supplied, and changes nothing when not', async () => {
    const { service: withAmount, audit: auditWith } = build({ version: CASHBACK_VERSION });
    await withAmount.attachReward(
      MAKER,
      CAMPAIGN,
      attach({ cashbackAmount: '25.50', cashbackCurrency: 'MYR' }),
    );

    const { service: without, audit: auditWithout } = build({ version: CASHBACK_VERSION });
    await without.attachReward(MAKER, CAMPAIGN, attach());

    expect(auditWith.events[0]?.['fieldChanges']).toEqual({
      level: 'campaign',
      refId: null,
      rewardPolicyId: 22,
      cashbackAmount: '25.50',
      cashbackCurrency: 'MYR',
    });
    expect(auditWithout.events[0]?.['fieldChanges']).toEqual({
      level: 'campaign',
      refId: null,
      rewardPolicyId: 22,
    });
  });
});

// --- points ------------------------------------------------------------------------------------

describe('points attach — the POINTS gate and config write', () => {
  it('writes the point count into the attached policy’s own config JSON', async () => {
    const { service, policy } = build({ version: POINTS_VERSION });

    await service.attachReward(MAKER, CAMPAIGN, attach({ points: 250 }));

    expect(writtenConfig(policy)).toEqual({ points: 250 });
  });

  it('rejects a points value sent for a reward that is not POINTS', async () => {
    const { service, scoped, policy } = build({ version: CASHBACK_VERSION });

    const error: unknown = await service
      .attachReward(MAKER, CAMPAIGN, attach({ points: 250 }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PointsNotApplicableError);
    const refusal = error as PointsNotApplicableError;
    expect(refusal.status).toBe(400);
    expect(refusal.code).toBe('POINTS_NOT_APPLICABLE');
    expect(scoped.created).toEqual([]);
    expect(policy.updates).toEqual([]);
  });

  it('a reward with no live version at all attaches fine when neither field is supplied', async () => {
    // Mirrors t127's own "no live version" case: `kind` is `null` there too, so — correctly —
    // it cannot validate *either* field against a Kind that isn't known. What is gated here is
    // supplying the field at all, not which Kind it's for; leaving both absent is the ordinary,
    // ungated path every reward authored before this feature already takes.
    const { service, scoped } = build({ version: null });

    await service.attachReward(MAKER, CAMPAIGN, attach());

    expect(scoped.created.map((row) => row.model)).toEqual([RewardCampaignAssignment.name]);
  });
});
