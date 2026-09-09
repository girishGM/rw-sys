/**
 * T-173 — the five fields this task appends to `BoundReward`: `expiry_value`, `expiry_unit`,
 * `reward_kind`, `promo_code_config_id` and `promo_code_config_version_no`.
 *
 * Three separate claims are being protected here, and they fail in different ways:
 *
 *  1. **The append is safe.** `campaign_config.v1.proto`'s rule 1 ("never renumber or reuse a field
 *     number") exists because reward-redemption-service (`T-RR-022`) and RAP both generate from
 *     that file independently and cannot renegotiate it. So the tests below do not merely restate
 *     that `expiry_value` is field 13 — they encode with the *old* twelve-field descriptor, decode
 *     with the new one and vice versa, and assert nothing shifts. A test asserting `no: 13` alone
 *     would still pass if field 7 had been renumbered underneath it (AGENT-PROTOCOL §3: "assert the
 *     observable property, not the implementation string").
 *  2. **The builder projects the right row.** In particular it must read the *resolved* version —
 *     the pinned one where there is a pin — so a reward reports the expiry the version it was
 *     pinned to promised, not whatever the newest version says today.
 *  3. **Absence stays absent.** A reward with no expiry, no Kind or no promo-code config must
 *     serialise as the zero value, never as a fabricated default (TC-3, TC-9, TC-11).
 *
 * The real database, the real CHECK constraints and the real socket are covered by
 * `reward-expiry-duration.e2e-spec.ts` and `test/database/reward-expiry-duration.migration.e2e-spec.ts`;
 * this suite is the isolated half.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sequelize } from 'sequelize-typescript';
import type { Model, ModelStatic } from 'sequelize';
import type { Transaction } from 'sequelize';
import { ConfigSnapshotBuilder } from '@/grpc/config-snapshot.builder';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { decodeMessage, encodeMessage, type MessageDescriptor } from '@/grpc/wire/proto-codec';
import { BoundRewardMessage } from '@/grpc/wire/campaign-config.messages';
import { CONFIG_SECTION } from '@/grpc/grpc.constants';
import {
  RewardCampaignAssignment,
  RewardPolicy,
  RewardSystem,
  RewardVersion,
  RewardVersionCountryAssignment,
  TenantCampaignTracker,
} from '@/database/models';
import type { TenantCampaign } from '@/database/models';
import type { SectionResolution } from '@/grpc/section-grant.guard';

const PROTO_PATH = join(__dirname, '../../proto/campaign_config.v1.proto');

// --- the `.proto` itself -----------------------------------------------------------------------

describe('T-173 — the .proto change is additive', () => {
  const source = readFileSync(PROTO_PATH, 'utf8');
  /** Comment-stripped, so a field name mentioned in prose is never mistaken for a declaration. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const rewardBlock = /message\s+BoundReward\s*\{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';

  it('appends five fields at 13-17 and leaves 1-12 exactly where they were', () => {
    expect(rewardBlock).not.toBe('');
    const fields = rewardBlock
      .split(';')
      .map((line) => line.trim().replace(/\s+/g, ' '))
      .filter((line) => line !== '')
      .map((line) => /^(repeated )?([\w.]+) (\w+) = (\d+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ type: match[2], name: match[3], no: Number(match[4]) }));

    expect(fields).toEqual([
      { type: 'int32', name: 'reward_id', no: 1 },
      { type: 'int32', name: 'reward_version_id', no: 2 },
      { type: 'int32', name: 'version_no', no: 3 },
      { type: 'string', name: 'system_code', no: 4 },
      { type: 'string', name: 'reward_type', no: 5 },
      { type: 'string', name: 'delivery_mode', no: 6 },
      { type: 'string', name: 'policies_json', no: 7 },
      { type: 'string', name: 'unit_type', no: 8 },
      { type: 'string', name: 'unit_code', no: 9 },
      { type: 'string', name: 'level', no: 10 },
      { type: 'int32', name: 'ref_id', no: 11 },
      { type: 'string', name: 'status', no: 12 },
      { type: 'int32', name: 'expiry_value', no: 13 },
      { type: 'string', name: 'expiry_unit', no: 14 },
      { type: 'string', name: 'reward_kind', no: 15 },
      { type: 'string', name: 'promo_code_config_id', no: 16 },
      { type: 'int32', name: 'promo_code_config_version_no', no: 17 },
    ]);
  });

  it('introduces no RPC at all: every rpc in the file is still a read', () => {
    // T-047 verification step 6, re-run for T-173 (implementation note 5). The service block is
    // untouched by this task; this asserts that as a property of the file, not of the diff.
    const rpcs = [...code.matchAll(/rpc\s+(\w+)\s*\(/g)].map((match) => match[1]);
    expect(rpcs).toEqual([
      'GetCampaignConfig',
      'ListActiveCampaigns',
      'WatchCampaignConfig',
      'ResolveRuleVersion',
      'ResolveRewardVersion',
      'GetBudgetStatus',
    ]);
    for (const name of rpcs) expect(name).toMatch(/^(Get|List|Watch|Resolve)/);
  });

  it('does not smuggle connector_config in with the new fields (rule 4)', () => {
    // Against the comment-stripped source: the prose deliberately *names* the token to say it is
    // absent (§6), so only a declaration counts as a violation.
    expect(code).not.toContain('connector_config');
  });

  it('adds no ConfigSection — the new fields ride on REWARDS, which already exists', () => {
    expect(Object.keys(CONFIG_SECTION)).toEqual([
      'CONFIG_SECTION_UNSPECIFIED',
      'BASIC',
      'MERCHANTS',
      'TRACKERS',
      'RULES',
      'REWARDS',
      'CAPS',
    ]);
  });
});

// --- wire compatibility ------------------------------------------------------------------------

/** `BoundReward` exactly as it stood **before** T-173 — the shape reward-redemption-service and RAP
 * still hold, having generated from the previous `.proto`. Hand-written on purpose: it is the other
 * side of the compatibility claim, so it must not be derived from the current descriptor. */
const PreT173BoundRewardMessage: MessageDescriptor = {
  name: 'BoundReward',
  fields: [
    { name: 'reward_id', no: 1, type: 'int32' },
    { name: 'reward_version_id', no: 2, type: 'int32' },
    { name: 'version_no', no: 3, type: 'int32' },
    { name: 'system_code', no: 4, type: 'string' },
    { name: 'reward_type', no: 5, type: 'string' },
    { name: 'delivery_mode', no: 6, type: 'string' },
    { name: 'policies_json', no: 7, type: 'string' },
    { name: 'unit_type', no: 8, type: 'string' },
    { name: 'unit_code', no: 9, type: 'string' },
    { name: 'level', no: 10, type: 'string' },
    { name: 'ref_id', no: 11, type: 'int32' },
    { name: 'status', no: 12, type: 'string' },
  ],
};

const FULL_REWARD = {
  rewardId: 7,
  rewardVersionId: 71,
  versionNo: 3,
  systemCode: 'CASHBACK_SYS',
  rewardType: 'CASHBACK',
  deliveryMode: 'realtime',
  policiesJson: '{"cap":10}',
  unitType: 'currency',
  unitCode: 'MYR',
  level: 'campaign',
  refId: 0,
  status: 'active',
  expiryValue: 15,
  expiryUnit: 'minutes',
  rewardKind: 'PERCENTAGE',
  promoCodeConfigId: '90210',
  promoCodeConfigVersionNo: 0,
};

describe('T-173 — BoundReward on the wire', () => {
  it('round-trips all five new fields', () => {
    expect(
      decodeMessage(BoundRewardMessage, encodeMessage(BoundRewardMessage, FULL_REWARD)),
    ).toEqual(FULL_REWARD);
  });

  it('TC-7 — a pre-T-173 consumer reads fields 1-12 unchanged from a message carrying 13-17', () => {
    // The guarantee rule 1 of the `.proto` is about, and the whole risk rating of this task: the
    // already-built reward-redemption-service stub must keep working. Had any new field taken an
    // existing number, this decode would return a corrupted `unit_code` or `policies_json`.
    expect(
      decodeMessage(PreT173BoundRewardMessage, encodeMessage(BoundRewardMessage, FULL_REWARD)),
    ).toEqual({
      rewardId: 7,
      rewardVersionId: 71,
      versionNo: 3,
      systemCode: 'CASHBACK_SYS',
      rewardType: 'CASHBACK',
      deliveryMode: 'realtime',
      policiesJson: '{"cap":10}',
      unitType: 'currency',
      unitCode: 'MYR',
      level: 'campaign',
      refId: 0,
      status: 'active',
    });
  });

  it('a message from a pre-T-173 producer decodes with zero values, never undefined', () => {
    // proto3 gives scalars no presence: "the producer never knew about the field" and "the producer
    // sent the zero value" must land identically in a strict consumer, and both must mean
    // "never expires" rather than "expired" (the `.proto` says so at fields 13/14).
    const decoded = decodeMessage(
      BoundRewardMessage,
      encodeMessage(PreT173BoundRewardMessage, {
        rewardId: 7,
        rewardVersionId: 71,
        versionNo: 3,
        systemCode: 'CASHBACK_SYS',
        rewardType: 'CASHBACK',
        deliveryMode: 'realtime',
        policiesJson: '{}',
        unitType: 'currency',
        unitCode: 'MYR',
        level: 'campaign',
        refId: 0,
        status: 'active',
      }),
    ) as Record<string, unknown>;

    expect(decoded.expiryValue).toBe(0);
    expect(decoded.expiryUnit).toBe('');
    expect(decoded.rewardKind).toBe('');
    expect(decoded.promoCodeConfigId).toBe('');
    expect(decoded.promoCodeConfigVersionNo).toBe(0);
    for (const key of [
      'expiryValue',
      'expiryUnit',
      'rewardKind',
      'promoCodeConfigId',
      'promoCodeConfigVersionNo',
    ]) {
      expect(decoded[key]).not.toBeUndefined();
    }
  });

  it('distinguishes a PERCENTAGE rate from a FIXED_AMOUNT of the same number', () => {
    // The correctness gap this task's objective §2 describes: `reward_value = 10` means 10% for one
    // and 10 MYR for the other, and before T-173 the wire carried nothing that told them apart.
    const rate = decodeMessage(
      BoundRewardMessage,
      encodeMessage(BoundRewardMessage, { ...FULL_REWARD, rewardKind: 'PERCENTAGE' }),
    ) as { rewardKind: string };
    const amount = decodeMessage(
      BoundRewardMessage,
      encodeMessage(BoundRewardMessage, { ...FULL_REWARD, rewardKind: 'FIXED_AMOUNT' }),
    ) as { rewardKind: string };

    expect(rate.rewardKind).toBe('PERCENTAGE');
    expect(amount.rewardKind).toBe('FIXED_AMOUNT');
    expect(rate.rewardKind).not.toBe(amount.rewardKind);
  });
});

// --- the builder's assembly ---------------------------------------------------------------------

/** A row-shaped stand-in. The builder only ever reads plain properties off these, so a literal is a
 * truthful double; casting through `unknown` (never `any` — R8) is how a test reaches a shape the
 * model's constructor type would otherwise demand a live connection for. */
const row = <T>(value: T): T => value;

interface VersionFixture {
  readonly id: number;
  readonly versionNo: number;
  readonly deliveryMode: string | null;
  readonly unitType: string | null;
  readonly unitCode: string | null;
  readonly policiesSnapshot: Record<string, unknown> | null;
  readonly rewardKind: string | null;
  readonly expiryValue: number | null;
  readonly expiryUnit: string | null;
}

function version(overrides: Partial<VersionFixture> & { id: number }): VersionFixture {
  return {
    versionNo: 1,
    deliveryMode: 'realtime',
    unitType: 'currency',
    unitCode: 'MYR',
    policiesSnapshot: null,
    rewardKind: null,
    expiryValue: null,
    expiryUnit: null,
    ...overrides,
  };
}

interface FakeReads {
  /** `reward_version_id` on the campaign-level assignment: the pin, or `null` for none. */
  readonly pinnedVersionId: number | null;
  readonly policyConfig: Record<string, unknown> | null;
  readonly versions: readonly VersionFixture[];
  /** Country assignments, newest first, used only when there is no pin. */
  readonly countryAssignments: readonly { rewardId: number; rewardVersionId: number }[];
}

const REWARDS_ONLY: SectionResolution = { returned: ['BASIC', 'REWARDS'], omitted: [] };

const campaign = row({
  id: 900,
  campaignCode: 'T173_C1',
  tenantId: 4,
  status: 'active',
  startDate: new Date('2027-01-01T00:00:00Z'),
  endDate: new Date('2027-01-31T00:00:00Z'),
  budgetAmount: null,
  budgetCurrency: null,
  maxParticipants: null,
  definitionPinnedAt: null,
  approvedAt: null,
}) as unknown as TenantCampaign;

const transaction = {} as unknown as Transaction;

const POLICY_ID = 55;
const REWARD_ID = 12;

async function buildRewards(reads: FakeReads) {
  const listAll = async (model: ModelStatic<Model>): Promise<unknown[]> => {
    if (model === (TenantCampaignTracker as unknown as ModelStatic<Model>)) return [];
    if (model === (RewardCampaignAssignment as unknown as ModelStatic<Model>)) {
      return [
        row({
          id: 1,
          rewardPolicyId: POLICY_ID,
          rewardVersionId: reads.pinnedVersionId,
          status: 'active',
        }),
      ];
    }
    if (model === (RewardPolicy as unknown as ModelStatic<Model>)) {
      return [row({ id: POLICY_ID, rewardSystemId: REWARD_ID, config: reads.policyConfig })];
    }
    if (model === (RewardSystem as unknown as ModelStatic<Model>)) {
      return [
        row({
          id: REWARD_ID,
          systemCode: 'T173_SYS',
          rewardType: 'CASHBACK',
          deliveryMode: 'batch',
        }),
      ];
    }
    if (model === (RewardVersion as unknown as ModelStatic<Model>)) return [...reads.versions];
    if (model === (RewardVersionCountryAssignment as unknown as ModelStatic<Model>)) {
      return reads.countryAssignments.map((entry) => row({ ...entry, status: 'active' }));
    }
    throw new Error(`unexpected model in this fixture: ${model.name}`);
  };
  const scoped = { listAll } as unknown as ScopedRepository;
  const builder = new ConfigSnapshotBuilder({} as unknown as Sequelize, scoped);
  const payload = await builder.build(campaign, 3, REWARDS_ONLY, transaction);
  return payload.rewards[0];
}

describe('T-173 — ConfigSnapshotBuilder projects the new fields', () => {
  it('TC-2 — a version with an expiry duration carries both halves', async () => {
    const reward = await buildRewards({
      pinnedVersionId: 71,
      policyConfig: {},
      versions: [version({ id: 71, expiryValue: 15, expiryUnit: 'minutes' })],
      countryAssignments: [],
    });

    expect(reward.expiryValue).toBe(15);
    expect(reward.expiryUnit).toBe('minutes');
  });

  it('TC-3 — a version with no expiry reports 0/"", never a fabricated default', async () => {
    const reward = await buildRewards({
      pinnedVersionId: 71,
      policyConfig: {},
      versions: [version({ id: 71 })],
      countryAssignments: [],
    });

    expect(reward.expiryValue).toBe(0);
    expect(reward.expiryUnit).toBe('');
    // The keys must exist: an omitted key and a zero value encode identically in proto3, but a
    // missing key would break any consumer of the payload *before* it is encoded.
    expect(Object.keys(reward)).toEqual(expect.arrayContaining(['expiryValue', 'expiryUnit']));
  });

  it('TC-8 — reward_kind is projected from the resolved version', async () => {
    const reward = await buildRewards({
      pinnedVersionId: 71,
      policyConfig: {},
      versions: [version({ id: 71, rewardKind: 'PERCENTAGE' })],
      countryAssignments: [],
    });

    expect(reward.rewardKind).toBe('PERCENTAGE');
  });

  it('TC-9 — reward_kind IS NULL becomes an empty string, not a guess', async () => {
    const reward = await buildRewards({
      pinnedVersionId: 71,
      policyConfig: {},
      versions: [version({ id: 71, rewardKind: null })],
      countryAssignments: [],
    });

    expect(reward.rewardKind).toBe('');
  });

  it('TC-10 — promo_code_config_id comes from reward_policies.config.promoCodeConfig', async () => {
    const reward = await buildRewards({
      pinnedVersionId: 71,
      policyConfig: { promoCodeConfig: '90210' },
      versions: [version({ id: 71, rewardKind: 'PROMO_CODE' })],
      countryAssignments: [],
    });

    expect(reward.promoCodeConfigId).toBe('90210');
    // Projected verbatim: promo-code-service's ids are opaque decimal STRINGS by contract, and a
    // consumer that received a number here would round-trip a 20-digit id wrongly.
    expect(typeof reward.promoCodeConfigId).toBe('string');
  });

  it('TC-11 — no promoCodeConfig means an empty id and version 0', async () => {
    const reward = await buildRewards({
      pinnedVersionId: 71,
      policyConfig: {},
      versions: [version({ id: 71 })],
      countryAssignments: [],
    });

    expect(reward.promoCodeConfigId).toBe('');
    expect(reward.promoCodeConfigVersionNo).toBe(0);
  });

  it('promo_code_config_version_no stays 0 even when a config IS bound (T-174 owns it)', async () => {
    // Implementation note 4: there is nowhere to read this from until T-174 adds one. Asserting it
    // here makes the "graceful degradation" claim a tested property rather than a promise in prose.
    const reward = await buildRewards({
      pinnedVersionId: 71,
      policyConfig: { promoCodeConfig: '90210' },
      versions: [version({ id: 71, rewardKind: 'PROMO_CODE' })],
      countryAssignments: [],
    });

    expect(reward.promoCodeConfigVersionNo).toBe(0);
  });

  it('a non-string promoCodeConfig is reported as absent, never coerced', async () => {
    const reward = await buildRewards({
      pinnedVersionId: 71,
      policyConfig: { promoCodeConfig: { id: 90210 } },
      versions: [version({ id: 71 })],
      countryAssignments: [],
    });

    expect(reward.promoCodeConfigId).toBe('');
  });

  it('honours the PIN: the pinned version’s expiry wins over a newer version’s', async () => {
    // The property this file's header calls out, and the reason the fields are read off `version`
    // rather than re-resolved: a blast publishing v2 with a shorter expiry must not retroactively
    // change what a live campaign pinned to v1 promised (06-VERSIONING.md §7).
    const reward = await buildRewards({
      pinnedVersionId: 71,
      policyConfig: {},
      versions: [
        version({ id: 71, versionNo: 1, expiryValue: 30, expiryUnit: 'days' }),
        version({ id: 72, versionNo: 2, expiryValue: 5, expiryUnit: 'minutes' }),
      ],
      countryAssignments: [{ rewardId: REWARD_ID, rewardVersionId: 72 }],
    });

    expect(reward.versionNo).toBe(1);
    expect(reward.expiryValue).toBe(30);
    expect(reward.expiryUnit).toBe('days');
  });

  it('an unpinned attachment resolves through the country assignment and carries its expiry', async () => {
    const reward = await buildRewards({
      pinnedVersionId: null,
      policyConfig: {},
      versions: [version({ id: 72, versionNo: 2, expiryValue: 5, expiryUnit: 'hours' })],
      countryAssignments: [{ rewardId: REWARD_ID, rewardVersionId: 72 }],
    });

    expect(reward.versionNo).toBe(2);
    expect(reward.expiryValue).toBe(5);
    expect(reward.expiryUnit).toBe('hours');
  });

  it('a reward with no resolvable version reports "never expires", not a partial guess', async () => {
    const reward = await buildRewards({
      pinnedVersionId: null,
      policyConfig: {},
      versions: [],
      countryAssignments: [],
    });

    expect(reward.rewardVersionId).toBe(0);
    expect(reward.expiryValue).toBe(0);
    expect(reward.expiryUnit).toBe('');
    expect(reward.rewardKind).toBe('');
  });
});
