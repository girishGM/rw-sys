/**
 * T-175 — the four fields this task appends to `BoundRule`: `operator`, `resolver_id`,
 * `resolver_config` and `default_operators`.
 *
 * The same three claims `reward-expiry-duration.spec.ts` (T-173) protects for `BoundReward`, for the
 * same reasons, plus one this task owns alone:
 *
 *  1. **The append is safe.** RAP generates `BoundRuleProto` from `campaign_config.v1.proto`
 *     independently (`campaign-config.client.ts` on its side) and reads it for every rule
 *     evaluation. So these tests encode with the *old* nine-field descriptor and decode with the new
 *     one, and vice versa, and assert nothing shifts — a test that only restated `no: 10` would
 *     still pass if field 7 had been renumbered underneath it (AGENT-PROTOCOL §3).
 *  2. **The builder projects the right row.** `operator` comes off the binding's own column, never
 *     out of `config`; the resolver trio comes off the *same* version the `expression` was read from
 *     — pinned where there is a pin — so an expression and its wiring can never disagree.
 *  3. **Absence stays absent.** No version, or a version with no resolver wired, serves `''`/`0`/
 *     `''`/`[]` — never a fabricated default (TC-2). T-RAP-064 needs "no resolver configured" to be
 *     distinguishable from "resolver configured but empty", and it only can be if the portal never
 *     invents one.
 *  4. **`resolver_config`/`default_operators` are `text` columns** (T-103), so what reaches the wire
 *     is a normalisation, not a copy: canonical JSON for the config, a real string list for the
 *     operators, and the empty value for anything that cannot be read as either.
 *
 * The real database, the real model → column mapping and the real config service are covered by
 * `rule-resolver-metadata.e2e-spec.ts`; this suite is the isolated half.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sequelize } from 'sequelize-typescript';
import type { Model, ModelStatic } from 'sequelize';
import type { Transaction } from 'sequelize';
import { Logger } from '@nestjs/common';
import { ConfigSnapshotBuilder } from '@/grpc/config-snapshot.builder';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { decodeMessage, encodeMessage, type MessageDescriptor } from '@/grpc/wire/proto-codec';
import { BoundRuleMessage } from '@/grpc/wire/campaign-config.messages';
import { CONFIG_SECTION } from '@/grpc/grpc.constants';
import {
  RuleMaster,
  RuleVersion,
  RuleVersionCountryAssignment,
  TenantCampaignTracker,
  TrackerComponentRule,
  TrackerTrackerComponent,
} from '@/database/models';
import type { TenantCampaign } from '@/database/models';
import type { SectionResolution } from '@/grpc/section-grant.guard';

const PROTO_PATH = join(__dirname, '../../proto/campaign_config.v1.proto');

// --- the `.proto` itself -----------------------------------------------------------------------

describe('T-175 — the .proto change is additive', () => {
  const source = readFileSync(PROTO_PATH, 'utf8');
  /** Comment-stripped, so a field name mentioned in prose is never mistaken for a declaration. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const ruleBlock = /message\s+BoundRule\s*\{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';

  it('appends four fields at 10-13 and leaves 1-9 exactly where they were', () => {
    expect(ruleBlock).not.toBe('');
    const fields = ruleBlock
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
      { repeated: false, type: 'int32', name: 'rule_id', no: 1 },
      { repeated: false, type: 'int32', name: 'rule_version_id', no: 2 },
      { repeated: false, type: 'int32', name: 'version_no', no: 3 },
      { repeated: false, type: 'string', name: 'rule_code', no: 4 },
      { repeated: false, type: 'string', name: 'expression', no: 5 },
      { repeated: false, type: 'string', name: 'parameters_json', no: 6 },
      { repeated: false, type: 'string', name: 'bound_values_json', no: 7 },
      { repeated: false, type: 'int32', name: 'tracker_component_id', no: 8 },
      { repeated: false, type: 'string', name: 'status', no: 9 },
      { repeated: false, type: 'string', name: 'operator', no: 10 },
      { repeated: false, type: 'int32', name: 'resolver_id', no: 11 },
      { repeated: false, type: 'string', name: 'resolver_config', no: 12 },
      { repeated: true, type: 'string', name: 'default_operators', no: 13 },
    ]);
  });

  it('the wire descriptor is a faithful transcription of the .proto', () => {
    // The hand-rolled codec has no code generator: `campaign-config.messages.ts` is typed by hand
    // from the `.proto`. A field present in one and not the other is exactly the kind of silent
    // wire break rule 1 of the `.proto` warns about, so the two are compared field for field.
    const declared = ruleBlock
      .split(';')
      .map((line) => line.trim().replace(/\s+/g, ' '))
      .map((line) => /^(repeated )?([\w.]+) (\w+) = (\d+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        name: match[3],
        no: Number(match[4]),
        type: match[2],
        repeated: match[1] !== undefined,
      }));
    const transcribed = BoundRuleMessage.fields.map((field) => ({
      name: field.name,
      no: field.no,
      type: field.type,
      repeated: field.repeated === true,
    }));
    expect(transcribed).toEqual(declared);
  });

  it('introduces no RPC at all: every rpc in the file is still a read', () => {
    // T-047 verification step 6, re-run for T-175 (implementation note 4).
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
    expect(code).not.toContain('connector_config');
  });

  it('adds no ConfigSection — the new fields ride on RULES, which already exists', () => {
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

/** `BoundRule` exactly as it stood **before** T-175 — the shape RAP's `BoundRuleProto` holds today,
 * having generated from the previous `.proto`. Hand-written on purpose: it is the other side of the
 * compatibility claim, so it must not be derived from the current descriptor. */
const PreT175BoundRuleMessage: MessageDescriptor = {
  name: 'BoundRule',
  fields: [
    { name: 'rule_id', no: 1, type: 'int32' },
    { name: 'rule_version_id', no: 2, type: 'int32' },
    { name: 'version_no', no: 3, type: 'int32' },
    { name: 'rule_code', no: 4, type: 'string' },
    { name: 'expression', no: 5, type: 'string' },
    { name: 'parameters_json', no: 6, type: 'string' },
    { name: 'bound_values_json', no: 7, type: 'string' },
    { name: 'tracker_component_id', no: 8, type: 'int32' },
    { name: 'status', no: 9, type: 'string' },
  ],
};

/** The T-RAP-063 row set B shape (`WELCOME_STREAK_LIVE` / `RULE_ACTIVITY_WINDOW_001`), verbatim. */
const FULL_RULE = {
  ruleId: 31,
  ruleVersionId: 14,
  versionNo: 1,
  ruleCode: 'RULE_ACTIVITY_WINDOW_001',
  expression: 'currentTime within the :windowType window',
  parametersJson: '{"fields":[]}',
  boundValuesJson: '{"windowType":"DAILY_HOURS","windowStart":"00:00","windowEnd":"23:59"}',
  trackerComponentId: 11,
  status: 'active',
  operator: 'between',
  resolverId: 5,
  resolverConfig: '{"field":"currentTime"}',
  defaultOperators: ['between', 'in', 'equals'],
};

const PRE_T175_VIEW = {
  ruleId: 31,
  ruleVersionId: 14,
  versionNo: 1,
  ruleCode: 'RULE_ACTIVITY_WINDOW_001',
  expression: 'currentTime within the :windowType window',
  parametersJson: '{"fields":[]}',
  boundValuesJson: '{"windowType":"DAILY_HOURS","windowStart":"00:00","windowEnd":"23:59"}',
  trackerComponentId: 11,
  status: 'active',
};

describe('T-175 — BoundRule on the wire', () => {
  it('round-trips all four new fields, the operator list in order', () => {
    expect(decodeMessage(BoundRuleMessage, encodeMessage(BoundRuleMessage, FULL_RULE))).toEqual(
      FULL_RULE,
    );
  });

  it('TC-4 — a pre-T-175 consumer reads fields 1-9 unchanged from a message carrying 10-13', () => {
    // The guarantee rule 1 of the `.proto` is about, and the whole risk rating of this task: RAP's
    // already-deployed stub keeps working. Had any new field taken an existing number, this decode
    // would return a corrupted `bound_values_json` or `expression`.
    expect(
      decodeMessage(PreT175BoundRuleMessage, encodeMessage(BoundRuleMessage, FULL_RULE)),
    ).toEqual(PRE_T175_VIEW);
  });

  it('a message from a pre-T-175 producer decodes with zero values, never undefined', () => {
    // proto3 gives scalars no presence: "the producer never knew about the field" and "the producer
    // sent the zero value" land identically in a strict consumer, and both must read as "no
    // resolver configured" rather than crash a consumer that indexes into `default_operators`.
    const decoded = decodeMessage(
      BoundRuleMessage,
      encodeMessage(PreT175BoundRuleMessage, PRE_T175_VIEW),
    ) as Record<string, unknown>;

    expect(decoded['operator']).toBe('');
    expect(decoded['resolverId']).toBe(0);
    expect(decoded['resolverConfig']).toBe('');
    expect(decoded['defaultOperators']).toEqual([]);
    for (const key of ['operator', 'resolverId', 'resolverConfig', 'defaultOperators']) {
      expect(decoded[key]).not.toBeUndefined();
    }
  });

  it('an empty default_operators list and an absent one are the same message', () => {
    // A repeated field has no presence either; the builder's `[]` for "none" must therefore encode
    // to nothing at all, so a consumer cannot be tricked into reading a phantom empty element.
    const withEmpty = encodeMessage(BoundRuleMessage, { ...FULL_RULE, defaultOperators: [] });
    const withoutKey = encodeMessage(BoundRuleMessage, {
      ...FULL_RULE,
      defaultOperators: undefined,
    });
    expect(withEmpty.equals(withoutKey)).toBe(true);
  });

  it('carries resolver_config as an opaque JSON string, exactly as given', () => {
    // The same treatment as `bound_values_json`: the codec must not re-parse, trim or re-encode it.
    const config = '{"field":"currentTime","nested":{"a":[1,2,3]},"unicode":"é"}';
    const decoded = decodeMessage(
      BoundRuleMessage,
      encodeMessage(BoundRuleMessage, { ...FULL_RULE, resolverConfig: config }),
    ) as { resolverConfig: string };
    expect(decoded.resolverConfig).toBe(config);
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
  readonly expression: string | null;
  readonly parameters: Record<string, unknown> | null;
  readonly resolverId: number | null;
  /** `text` in the database — a JSON document, or anything a legacy row might hold. */
  readonly resolverConfig: string | null;
  /** `text` in the database — JSON array text, or anything a legacy row might hold. */
  readonly defaultOperators: string | null;
}

function version(overrides: Partial<VersionFixture> & { id: number }): VersionFixture {
  return {
    versionNo: 1,
    expression: 'currentTime within the :windowType window',
    parameters: { fields: [] },
    resolverId: null,
    resolverConfig: null,
    defaultOperators: null,
    ...overrides,
  };
}

interface FakeReads {
  /** `tracker_component_rules.rule_version_id`: the pin, or `null` for none. */
  readonly pinnedVersionId: number | null;
  /** `tracker_component_rules.operator`. */
  readonly operator: string | null;
  /** `tracker_component_rules.config` — `boundValuesJson`'s source, deliberately separate. */
  readonly config: Record<string, unknown> | null;
  readonly versions: readonly VersionFixture[];
  /** Country assignments, newest first, used only when there is no pin. */
  readonly countryAssignments: readonly { ruleId: number; ruleVersionId: number }[];
}

const RULES_ONLY: SectionResolution = { returned: ['BASIC', 'RULES'], omitted: [] };

const campaign = row({
  id: 900,
  campaignCode: 'T175_C1',
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

const TRACKER_ID = 40;
const COMPONENT_ID = 41;
const RULE_ID = 31;

async function buildRule(reads: FakeReads) {
  const listAll = async (model: ModelStatic<Model>): Promise<unknown[]> => {
    if (model === (TenantCampaignTracker as unknown as ModelStatic<Model>)) {
      return [row({ id: 1, campaignId: campaign.id, trackerId: TRACKER_ID, status: 'active' })];
    }
    if (model === (TrackerTrackerComponent as unknown as ModelStatic<Model>)) {
      return [
        row({
          id: 1,
          trackerId: TRACKER_ID,
          componentId: COMPONENT_ID,
          sequenceOrder: 1,
          isMandatory: true,
        }),
      ];
    }
    if (model === (TrackerComponentRule as unknown as ModelStatic<Model>)) {
      return [
        row({
          id: 11,
          trackerComponentId: COMPONENT_ID,
          ruleId: RULE_ID,
          ruleVersionId: reads.pinnedVersionId,
          operator: reads.operator,
          value: null,
          config: reads.config,
          status: 'active',
        }),
      ];
    }
    if (model === (RuleMaster as unknown as ModelStatic<Model>)) {
      return [
        row({
          id: RULE_ID,
          ruleCode: 'RULE_ACTIVITY_WINDOW_001',
          expression: 'currentTime within the :windowType window',
          parameters: { fields: [] },
        }),
      ];
    }
    if (model === (RuleVersion as unknown as ModelStatic<Model>)) return [...reads.versions];
    if (model === (RuleVersionCountryAssignment as unknown as ModelStatic<Model>)) {
      return reads.countryAssignments.map((entry) => row({ ...entry, status: 'active' }));
    }
    throw new Error(`unexpected model in this fixture: ${model.name}`);
  };
  const scoped = { listAll } as unknown as ScopedRepository;
  const builder = new ConfigSnapshotBuilder({} as unknown as Sequelize, scoped);
  const payload = await builder.build(campaign, 3, RULES_ONLY, transaction);
  expect(payload.rules).toHaveLength(1);
  return payload.rules[0];
}

/** Row set B of the T-RAP-063 diagnosis, as the fixture the builder is asked to project. */
const SCHEDULE_VERSION = version({
  id: 14,
  resolverId: 5,
  resolverConfig: '{"field":"currentTime"}',
  defaultOperators: '["between","in","equals"]',
});

describe('T-175 — ConfigSnapshotBuilder projects the new fields', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('TC-1 — a binding pinned to a resolver-wired version carries all three resolver fields', async () => {
    const rule = await buildRule({
      pinnedVersionId: 14,
      operator: null,
      config: { windowType: 'DAILY_HOURS', windowStart: '00:00', windowEnd: '23:59' },
      versions: [SCHEDULE_VERSION],
      countryAssignments: [],
    });

    expect(rule.ruleVersionId).toBe(14);
    expect(rule.resolverId).toBe(5);
    expect(rule.resolverConfig).toBe('{"field":"currentTime"}');
    expect(rule.defaultOperators).toEqual(['between', 'in', 'equals']);
    // What the wire carried before this task, unchanged beside the new fields.
    expect(rule.expression).toBe('currentTime within the :windowType window');
    expect(rule.boundValuesJson).toBe(
      '{"windowType":"DAILY_HOURS","windowStart":"00:00","windowEnd":"23:59"}',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('TC-2 — no pinned version and nothing assigned: every new field is its zero value, not a guess', async () => {
    // Row set A of the diagnosis (`RULE_ACTIVITY_VALUE_001`): `rule_version_id IS NULL`,
    // `operator IS NULL`, config holding untouched form defaults.
    const rule = await buildRule({
      pinnedVersionId: null,
      operator: null,
      config: { value: 0, currency: 'MYR' },
      versions: [],
      countryAssignments: [],
    });

    expect(rule.ruleVersionId).toBe(0);
    expect(rule.operator).toBe('');
    expect(rule.resolverId).toBe(0);
    expect(rule.resolverConfig).toBe('');
    expect(rule.defaultOperators).toEqual([]);
    // The keys must exist: an omitted key and a zero value encode identically in proto3, but a
    // missing key would break any consumer of the payload *before* it is encoded.
    expect(Object.keys(rule)).toEqual(
      expect.arrayContaining(['operator', 'resolverId', 'resolverConfig', 'defaultOperators']),
    );
    // And the values that were already on the wire are untouched by the new reads.
    expect(rule.boundValuesJson).toBe('{"value":0,"currency":"MYR"}');
  });

  it('TC-3 — operator is read off the binding column and matches exactly', async () => {
    const rule = await buildRule({
      pinnedVersionId: 14,
      operator: 'between',
      config: {},
      versions: [SCHEDULE_VERSION],
      countryAssignments: [],
    });

    expect(rule.operator).toBe('between');
  });

  it('TC-3 — operator is never taken from config, nor config from operator', async () => {
    // Implementation note 3: two independent reads. A `config.operator` key is just a bound value;
    // a column `operator` is not folded into `boundValuesJson`.
    const rule = await buildRule({
      pinnedVersionId: 14,
      operator: '>=',
      config: { operator: 'in', value: 100 },
      versions: [SCHEDULE_VERSION],
      countryAssignments: [],
    });

    expect(rule.operator).toBe('>=');
    expect(rule.boundValuesJson).toBe('{"operator":"in","value":100}');
  });

  it('a pinned version with no resolver wired serves 0/""/[] — not the rule master, not a guess', async () => {
    // "Resolver configured but empty" and "no resolver configured" must stay distinguishable; the
    // portal's side of that is to never invent the former.
    const rule = await buildRule({
      pinnedVersionId: 14,
      operator: null,
      config: {},
      versions: [version({ id: 14 })],
      countryAssignments: [],
    });

    expect(rule.ruleVersionId).toBe(14);
    expect(rule.resolverId).toBe(0);
    expect(rule.resolverConfig).toBe('');
    expect(rule.defaultOperators).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a resolver with a genuinely empty config serves "{}", distinct from no resolver at all', async () => {
    const rule = await buildRule({
      pinnedVersionId: 14,
      operator: null,
      config: {},
      versions: [version({ id: 14, resolverId: 5, resolverConfig: '{}', defaultOperators: '[]' })],
      countryAssignments: [],
    });

    expect(rule.resolverId).toBe(5);
    expect(rule.resolverConfig).toBe('{}');
    expect(rule.defaultOperators).toEqual([]);
  });

  it('honours the PIN: the pinned version’s resolver wins over a newer assigned version’s', async () => {
    // The same property T-047's TC-3/TC-23 protect for `expression`, extended to the wiring that
    // binds it: a blast publishing v2 with a different resolver must not retroactively change what
    // a live campaign pinned to v1 evaluates against (06-VERSIONING.md §7).
    const rule = await buildRule({
      pinnedVersionId: 14,
      operator: null,
      config: {},
      versions: [
        SCHEDULE_VERSION,
        version({
          id: 15,
          versionNo: 2,
          resolverId: 1,
          resolverConfig: '{"path":"$.amount"}',
          defaultOperators: '[">="]',
        }),
      ],
      countryAssignments: [{ ruleId: RULE_ID, ruleVersionId: 15 }],
    });

    expect(rule.versionNo).toBe(1);
    expect(rule.resolverId).toBe(5);
    expect(rule.resolverConfig).toBe('{"field":"currentTime"}');
    expect(rule.defaultOperators).toEqual(['between', 'in', 'equals']);
  });

  it('an unpinned binding that resolves through the country assignment carries THAT version’s wiring', async () => {
    // The builder already serves such a binding's `rule_version_id`/`expression` from the version
    // assigned to the country at the pin date (this file's header §2 in the builder). The resolver
    // fields come off the same row: serving an expression with the wiring of a different version
    // — or none — would be the internally inconsistent response §10 forbids.
    const rule = await buildRule({
      pinnedVersionId: null,
      operator: null,
      config: {},
      versions: [version({ ...SCHEDULE_VERSION, id: 15, versionNo: 2 })],
      countryAssignments: [{ ruleId: RULE_ID, ruleVersionId: 15 }],
    });

    expect(rule.ruleVersionId).toBe(15);
    expect(rule.versionNo).toBe(2);
    expect(rule.resolverId).toBe(5);
    expect(rule.resolverConfig).toBe('{"field":"currentTime"}');
    expect(rule.defaultOperators).toEqual(['between', 'in', 'equals']);
  });

  it('resolver_config is served as canonical JSON, the same treatment as bound_values_json', async () => {
    const rule = await buildRule({
      pinnedVersionId: 14,
      operator: null,
      config: {},
      versions: [
        version({ id: 14, resolverId: 5, resolverConfig: ' { "field" :\n"currentTime" } ' }),
      ],
      countryAssignments: [],
    });

    expect(rule.resolverConfig).toBe('{"field":"currentTime"}');
    expect(JSON.parse(rule.resolverConfig)).toEqual({ field: 'currentTime' });
  });

  it('malformed resolver_config text is served as empty and logged, never passed through', async () => {
    // Impossible via the portal's own write path (stored from a validated object), so this is a
    // legacy-row guard: the runtime must never receive bytes it cannot parse under a resolver id it
    // will act on, and the operator must be able to find out why the field is empty.
    const rule = await buildRule({
      pinnedVersionId: 14,
      operator: null,
      config: {},
      versions: [version({ id: 14, resolverId: 5, resolverConfig: '{not json' })],
      countryAssignments: [],
    });

    expect(rule.resolverId).toBe(5);
    expect(rule.resolverConfig).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('malformed resolver_config');
  });

  it('default_operators that is not a JSON array of strings is served as [] and logged', async () => {
    for (const bad of ['{"a":1}', '"between"', '[1,2]', '["between",null]', 'nope']) {
      warn.mockClear();
      const rule = await buildRule({
        pinnedVersionId: 14,
        operator: null,
        config: {},
        versions: [version({ id: 14, resolverId: 5, defaultOperators: bad })],
        countryAssignments: [],
      });

      expect(rule.defaultOperators).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('default_operators');
    }
  });

  it('default_operators keeps the stored order — it is a list, not a set', async () => {
    const rule = await buildRule({
      pinnedVersionId: 14,
      operator: null,
      config: {},
      versions: [version({ id: 14, resolverId: 5, defaultOperators: '["in","equals","between"]' })],
      countryAssignments: [],
    });

    expect(rule.defaultOperators).toEqual(['in', 'equals', 'between']);
  });

  it('the projected payload survives the real codec unchanged (TC-1 end to end, in memory)', async () => {
    const rule = await buildRule({
      pinnedVersionId: 14,
      operator: 'between',
      config: { windowType: 'DAILY_HOURS' },
      versions: [SCHEDULE_VERSION],
      countryAssignments: [],
    });

    const decoded = decodeMessage(
      BoundRuleMessage,
      encodeMessage(BoundRuleMessage, rule as unknown as Record<string, unknown>),
    ) as Record<string, unknown>;
    expect(decoded['operator']).toBe('between');
    expect(decoded['resolverId']).toBe(5);
    expect(decoded['resolverConfig']).toBe('{"field":"currentTime"}');
    expect(decoded['defaultOperators']).toEqual(['between', 'in', 'equals']);
  });
});
