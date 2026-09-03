/**
 * T-171 — `Activity.external_codes`, the one field this task appends to a contract an external
 * system already consumes.
 *
 * Two things are being protected here, and they are different:
 *
 *  1. **The append is safe.** `campaign_config.v1.proto`'s own rule 1 ("never renumber or reuse a
 *     field number") exists because `realtime-activity-processing-service` generates from that file
 *     independently and cannot renegotiate it. So the tests below do not merely restate that the
 *     new field is number 4 — they encode a message with the *old* three-field descriptor, decode
 *     it with the new one, and vice versa, and assert nothing shifts. A test that only asserted
 *     `no: 4` would still pass if field 2 had been renumbered underneath it (AGENT-PROTOCOL §3:
 *     "assert the observable property, not the implementation string").
 *  2. **The builder assembles the field correctly** — grouped by activity, sorted, and an empty
 *     list rather than a missing key when an activity has no external code (TC-3).
 *
 * The real database, the real join and the real socket are covered by
 * `activity-external-codes.e2e-spec.ts` beside this file; this suite is the isolated half.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sequelize } from 'sequelize-typescript';
import type { Model, ModelStatic } from 'sequelize';
import { ConfigSnapshotBuilder } from '@/grpc/config-snapshot.builder';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { decodeMessage, encodeMessage, type MessageDescriptor } from '@/grpc/wire/proto-codec';
import { ActivityMessage } from '@/grpc/wire/campaign-config.messages';
import { CONFIG_SECTION } from '@/grpc/grpc.constants';
import { Activity, CampaignMerchant, Merchant, MerchantActivity } from '@/database/models';
import { ActivityExternalCode } from '@/database/portal-models';
import type { SectionResolution } from '@/grpc/section-grant.guard';
import type { TenantCampaign } from '@/database/models';
import type { Transaction } from 'sequelize';

const PROTO_PATH = join(__dirname, '../../proto/campaign_config.v1.proto');

// --- the `.proto` itself -----------------------------------------------------------------------

describe('T-171 — the .proto change is additive', () => {
  const source = readFileSync(PROTO_PATH, 'utf8');
  /** Comment-stripped, so a field name mentioned in prose is never mistaken for a declaration. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const activityBlock = /message\s+Activity\s*\{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';

  it('appends external_codes as field 4 and leaves 1-3 exactly where they were', () => {
    expect(activityBlock).not.toBe('');
    const fields = activityBlock
      .split(';')
      .map((line) => line.trim().replace(/\s+/g, ' '))
      .filter((line) => line !== '')
      .map((line) => /^(repeated )?([\w.]+) (\w+) = (\d+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        repeated: match[1] !== undefined,
        type: match[2],
        name: match[3],
        no: Number(match[4]),
      }));

    expect(fields).toEqual([
      { repeated: false, type: 'int32', name: 'activity_id', no: 1 },
      { repeated: false, type: 'string', name: 'activity_code', no: 2 },
      { repeated: false, type: 'string', name: 'name', no: 3 },
      { repeated: true, type: 'string', name: 'external_codes', no: 4 },
    ]);
  });

  it('TC-5 — introduces no RPC at all: every rpc in the file is still a read', () => {
    // Verification step 6 of T-047, re-run for T-171. The service block is unchanged by this task;
    // this asserts that as a property of the file rather than trusting the diff.
    const rpcs = [...code.matchAll(/rpc\s+(\w+)\s*\(/g)].map((match) => match[1]);
    expect(rpcs).toEqual([
      'GetCampaignConfig',
      'ListActiveCampaigns',
      'WatchCampaignConfig',
      'ResolveRuleVersion',
      'ResolveRewardVersion',
      'GetBudgetStatus',
    ]);
    for (const name of rpcs) {
      expect(name).toMatch(/^(Get|List|Watch|Resolve)/);
    }
  });

  it('does not smuggle connector_config in with the new field (rule 4)', () => {
    // Against the comment-stripped source: the prose deliberately *names* the token to say it is
    // absent (§6), so only a declaration counts as a violation.
    expect(code).not.toContain('connector_config');
  });
});

// --- wire compatibility ------------------------------------------------------------------------

/** The `Activity` descriptor exactly as it stood **before** T-171 — the shape a consumer that
 * generated from the previous `.proto` still holds. Hand-written on purpose: it is the other
 * side of the compatibility claim, so it must not be derived from the current descriptor. */
const PreT171ActivityMessage: MessageDescriptor = {
  name: 'Activity',
  fields: [
    { name: 'activity_id', no: 1, type: 'int32' },
    { name: 'activity_code', no: 2, type: 'string' },
    { name: 'name', no: 3, type: 'string' },
  ],
};

describe('T-171 — Activity.external_codes on the wire', () => {
  it('round-trips several codes, in order', () => {
    const encoded = encodeMessage(ActivityMessage, {
      activityId: 42,
      activityCode: 'PURCHASE',
      name: 'Purchase',
      externalCodes: ['CARD_TXN', 'POS_SALE'],
    });

    expect(decodeMessage(ActivityMessage, encoded)).toEqual({
      activityId: 42,
      activityCode: 'PURCHASE',
      name: 'Purchase',
      externalCodes: ['CARD_TXN', 'POS_SALE'],
    });
  });

  it('TC-3 — an activity with no external codes decodes to an empty list, not undefined', () => {
    // Both directions of "empty": the producer sent `[]`, and a producer that never knew about the
    // field sent nothing at all. proto3 gives a repeated field no presence, so both must land on
    // the same value in a strict consumer — an empty list it can iterate, never `null`/`undefined`.
    const sentEmpty = decodeMessage(
      ActivityMessage,
      encodeMessage(ActivityMessage, {
        activityId: 7,
        activityCode: 'REFUND',
        name: 'Refund',
        externalCodes: [],
      }),
    ) as { externalCodes: unknown };
    const neverSent = decodeMessage(
      ActivityMessage,
      encodeMessage(PreT171ActivityMessage, {
        activityId: 7,
        activityCode: 'REFUND',
        name: 'Refund',
      }),
    ) as { externalCodes: unknown };

    expect(sentEmpty.externalCodes).toEqual([]);
    expect(neverSent.externalCodes).toEqual([]);
    expect(sentEmpty.externalCodes).not.toBeUndefined();
    expect(neverSent.externalCodes).not.toBeUndefined();
  });

  it('a pre-T-171 consumer reads fields 1-3 unchanged from a message carrying field 4', () => {
    // The actual guarantee rule 1 of the .proto is about: the runtime team's already-generated
    // stub must keep working. If `external_codes` had taken an existing number instead of the next
    // free one, this decode would return a corrupted `name` or `activity_code`.
    const encoded = encodeMessage(ActivityMessage, {
      activityId: 99,
      activityCode: 'TOPUP',
      name: 'Top up',
      externalCodes: ['WALLET_LOAD'],
    });

    expect(decodeMessage(PreT171ActivityMessage, encoded)).toEqual({
      activityId: 99,
      activityCode: 'TOPUP',
      name: 'Top up',
    });
  });

  it('encodes each code as its own length-delimited field 4 record', () => {
    // proto3 does not pack repeated strings. Asserting the bytes matters because a packed
    // encoding would decode as one code containing a NUL-ish blob on a conformant consumer.
    const encoded = encodeMessage(ActivityMessage, {
      activityId: 1,
      activityCode: 'A',
      name: 'A',
      externalCodes: ['X', 'YY'],
    });
    const tag = 4 * 8 + 2; // field 4, wire type 2 (length-delimited)
    const occurrences = [...encoded].filter((byte) => byte === tag).length;

    expect(occurrences).toBe(2);
  });
});

// --- the builder's assembly ----------------------------------------------------------------------

/** A row-shaped stand-in. The builder only ever reads plain properties off these, so a literal is
 * a truthful double; casting through `unknown` (never `any` — R8) is how a test reaches a shape
 * the model's constructor type would otherwise demand a live connection for. */
const row = <T>(value: T): T => value;

interface FakeReads {
  readonly campaignMerchants: readonly unknown[];
  readonly merchants: readonly unknown[];
  readonly merchantActivities: readonly unknown[];
  readonly activities: readonly unknown[];
  readonly externalCodes: readonly unknown[];
}

/** A `ScopedRepository` that answers `listAll` from a fixture keyed by model, and records the
 * options it was called with so the ordering claim can be asserted rather than assumed. */
function fakeScoped(reads: FakeReads): {
  scoped: ScopedRepository;
  calls: Map<string, Record<string, unknown>>;
} {
  const calls = new Map<string, Record<string, unknown>>();
  const listAll = async (
    model: ModelStatic<Model>,
    options: Record<string, unknown> = {},
  ): Promise<unknown[]> => {
    calls.set(model.name, options);
    if (model === (CampaignMerchant as unknown as ModelStatic<Model>)) {
      return [...reads.campaignMerchants];
    }
    if (model === (Merchant as unknown as ModelStatic<Model>)) return [...reads.merchants];
    if (model === (MerchantActivity as unknown as ModelStatic<Model>)) {
      return [...reads.merchantActivities];
    }
    if (model === (Activity as unknown as ModelStatic<Model>)) return [...reads.activities];
    if (model === (ActivityExternalCode as unknown as ModelStatic<Model>)) {
      return [...reads.externalCodes];
    }
    throw new Error(`unexpected model in this fixture: ${model.name}`);
  };
  return { scoped: { listAll } as unknown as ScopedRepository, calls };
}

const MERCHANTS_ONLY: SectionResolution = {
  returned: ['BASIC', 'MERCHANTS'],
  omitted: [],
};

const campaign = row({
  id: 500,
  campaignCode: 'T171_C1',
  tenantId: 9,
  status: 'active',
  startDate: '2027-01-01',
  endDate: '2027-01-31',
  budgetAmount: null,
  budgetCurrency: null,
  maxParticipants: null,
}) as unknown as TenantCampaign;

const transaction = {} as unknown as Transaction;

async function buildMerchants(externalCodes: readonly unknown[]) {
  const { scoped, calls } = fakeScoped({
    campaignMerchants: [row({ id: 1, merchantId: 11, status: 'active' })],
    merchants: [row({ id: 11, merchantCode: 'M1', name: 'Merchant One', status: 'active' })],
    merchantActivities: [
      row({ id: 1, merchantId: 11, activityId: 21, status: 'active' }),
      row({ id: 2, merchantId: 11, activityId: 22, status: 'active' }),
    ],
    activities: [
      row({ id: 21, activityCode: 'PURCHASE', name: 'Purchase' }),
      row({ id: 22, activityCode: 'REFUND', name: 'Refund' }),
    ],
    externalCodes,
  });
  const builder = new ConfigSnapshotBuilder({} as unknown as Sequelize, scoped);
  const payload = await builder.build(campaign, 3, MERCHANTS_ONLY, transaction);
  return { payload, calls };
}

describe('T-171 — ConfigSnapshotBuilder populates external_codes', () => {
  it('TC-2 — an activity with two external codes carries both', async () => {
    const { payload } = await buildMerchants([
      row({ activityId: 21, externalCode: 'CARD_TXN' }),
      row({ activityId: 21, externalCode: 'POS_SALE' }),
    ]);

    expect(payload.merchants[0].activities[0].externalCodes).toEqual(['CARD_TXN', 'POS_SALE']);
  });

  it('groups by activity — a code never leaks onto a sibling activity', async () => {
    const { payload } = await buildMerchants([
      row({ activityId: 21, externalCode: 'CARD_TXN' }),
      row({ activityId: 22, externalCode: 'REVERSAL' }),
    ]);
    const [purchase, refund] = payload.merchants[0].activities;

    expect(purchase.externalCodes).toEqual(['CARD_TXN']);
    expect(refund.externalCodes).toEqual(['REVERSAL']);
  });

  it('TC-3 — an activity with no configured code gets an empty array, not a missing key', async () => {
    const { payload } = await buildMerchants([row({ activityId: 21, externalCode: 'CARD_TXN' })]);
    const refund = payload.merchants[0].activities[1];

    expect(refund.externalCodes).toEqual([]);
    expect(Object.keys(refund)).toContain('externalCodes');
  });

  it('asks the database for a deterministic order, so config_hash is stable (§11)', async () => {
    const { calls } = await buildMerchants([]);

    expect(calls.get('ActivityExternalCode')).toMatchObject({
      order: [['externalCode', 'ASC']],
    });
  });

  it('reads no external codes at all when the campaign has no activities', async () => {
    const { scoped, calls } = fakeScoped({
      campaignMerchants: [row({ id: 1, merchantId: 11, status: 'active' })],
      merchants: [row({ id: 11, merchantCode: 'M1', name: 'Merchant One', status: 'active' })],
      merchantActivities: [],
      activities: [],
      externalCodes: [],
    });
    const builder = new ConfigSnapshotBuilder({} as unknown as Sequelize, scoped);

    const payload = await builder.build(campaign, 3, MERCHANTS_ONLY, transaction);

    expect(payload.merchants[0].activities).toEqual([]);
    expect(calls.has('ActivityExternalCode')).toBe(false);
  });

  it('MERCHANTS is the section that carries it — no new section was invented', () => {
    // Implementation note 4: `external_codes` rides along with whatever section already carries
    // Merchant/Activity, so the ConfigSection enum is untouched by this task.
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
