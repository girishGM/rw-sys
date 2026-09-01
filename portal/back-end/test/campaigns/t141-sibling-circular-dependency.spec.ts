/**
 * T-141 — the **server-side** re-check of T-124's sibling-component circular-dependency rule
 * (`13-REWARD-MASTER-VALUE-SOURCES.md` §3), independently re-verified missing from the working
 * tree despite T-124 being marked `done` — see this task's own file for the root-cause evidence
 * (an uncommitted-work-losing `git reset` a few seconds after T-124's review).
 *
 * ### Why this is a unit spec against a faked repository, not only an e2e spec
 *
 * `campaigns.e2e-spec.ts` (T-037) already proves membership/tenancy/country-visibility against
 * the real database; that is not what regressed here. What regressed is a **pure decision** —
 * *given this binding's own `sequence_order` and the value a Maker supplied for a
 * `SIBLING_COMPONENTS` field, is the target strictly earlier?* — which is exactly the shape
 * `t127-promo-code-attach.spec.ts` and `t136-value-source-binding.spec.ts` already use a faked
 * `ScopedRepository` for. Unlike those two files' fakes, this one's `listAll` genuinely applies
 * `where` (equality and `Op.in`): the guard issues two structurally different
 * `TrackerTrackerComponent` lookups per call (the binding's own component, then the field's
 * target) against **one** shared fixture, so a fake that ignores `where` and returns "row zero"
 * cannot tell them apart — it would pass every case here by accident.
 *
 * ### Proving the regression, not just the fix (AGENT-PROTOCOL §4, TC-3)
 *
 * TC-2 through TC-6 below were run once with `assertNoCircularSiblingDependency`'s call sites in
 * `bindings.service.ts` commented out (the exact absence this task diagnosed) and observed red —
 * every one of them created the binding instead of refusing it. Restoring the two call sites
 * (`bindRule`, `updateRuleValues`) is the complete fix; see the completion report for the
 * red-run transcript.
 */
import { Op, type FindOptions, type Model, type ModelStatic, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type { CampaignAuditService } from '@/modules/campaigns/campaign-audit.service';
import type { PromoCodeServiceClient } from '@/modules/promo-code-integration/promo-code-service.client';
import type { TenantCampaign } from '@/database/models';
import {
  RuleMaster,
  TenantCampaignTracker,
  TrackerComponentRule,
  TrackerTrackerComponent,
} from '@/database/models';
import { BindingsService } from '@/modules/campaigns/bindings.service';
import { SiblingComponentNotEarlierError } from '@/modules/campaigns/campaigns.errors';
import type { BindComponentRuleDto } from '@/modules/campaigns/dto/binding.dto';

// --- doubles -------------------------------------------------------------------------------------

/**
 * `scoped-lookup.ts#byIdOrNull` (used by `resolveRule`/`parametersForBinding`) keys its `where`
 * on `model.primaryKeyAttribute` — populated by Sequelize's own `Model.init()`, which only a
 * bootstrapped `Sequelize` instance runs. Outside one (as here, and in every other unit spec in
 * this folder), it is `undefined`, so `byIdOrNull` builds a literal `{ undefined: id }` clause.
 * T-127's/T-136's own fakes never notice, because both ignore `where` entirely and return their
 * whole scripted set regardless of the query — the thing this file's header explains this double
 * cannot do. Remapping that one literal key back onto the fixture's own `id` is what lets a
 * genuinely-filtering fake coexist with `byIdOrNull` at all.
 */
function normaliseWhere(where: FindOptions['where']): Record<string, unknown> | undefined {
  if (where === undefined || where === null) return undefined;
  return Object.fromEntries(
    Object.entries(where as Record<string, unknown>).map(([key, value]) => [
      key === 'undefined' ? 'id' : key,
      value,
    ]),
  );
}

/**
 * Matches a fixture row against a Sequelize `where` clause — equality and `Op.in` only, which is
 * every shape `campaign-membership.ts`/`bindings.service.ts` actually issue. Anything richer than
 * that is not needed here and would only make this double harder to trust.
 */
function matchesWhere(row: Record<string, unknown>, where: FindOptions['where']): boolean {
  const normalised = normaliseWhere(where);
  if (normalised === undefined) return true;
  return Object.entries(normalised).every(([key, condition]) => {
    if (condition !== null && typeof condition === 'object' && Op.in in condition) {
      const list = (condition as Record<symbol, unknown>)[Op.in];
      return Array.isArray(list) && list.includes(row[key]);
    }
    return row[key] === condition;
  });
}

/**
 * A `ScopedRepository` double whose `listAll` genuinely filters by `where` (see this file's
 * header for why the folder's existing single-row fakes will not do here), plus the handful of
 * other methods `BindingsService`'s write paths call.
 */
class FakeScoped {
  readonly created: { model: string; values: Record<string, unknown> }[] = [];
  private readonly rows = new Map<string, Record<string, unknown>[]>();
  private nextId = 9001;

  setRows(model: ModelStatic<Model>, rows: readonly unknown[]): this {
    this.rows.set(model.name, [...(rows as Record<string, unknown>[])]);
    return this;
  }

  async listAll<M extends Model>(model: ModelStatic<M>, options: FindOptions = {}): Promise<M[]> {
    const all = this.rows.get(model.name) ?? [];
    const filtered = all.filter((row) => matchesWhere(row, options.where));
    const limited = options.limit === undefined ? filtered : filtered.slice(0, options.limit);
    return limited as unknown as M[];
  }

  async count(model: ModelStatic<Model>, options: FindOptions = {}): Promise<number> {
    return (await this.listAll(model, options)).length;
  }

  async findByPkOrFail<M extends Model>(model: ModelStatic<M>, id: number): Promise<M> {
    const row = (this.rows.get(model.name) ?? []).find((candidate) => candidate['id'] === id);
    if (row === undefined) throw new Error(`no scripted ${model.name} row with id ${id}`);
    return row as unknown as M;
  }

  async create<M extends Model>(model: ModelStatic<M>, values: unknown): Promise<M> {
    const row = { id: this.nextId++, ...(values as object) } as Record<string, unknown>;
    this.created.push({ model: model.name, values: values as Record<string, unknown> });
    this.rows.set(model.name, [...(this.rows.get(model.name) ?? []), row]);
    return row as unknown as M;
  }

  async update(model: ModelStatic<Model>): Promise<number> {
    // No case below reads an updated row back through this double — `updateRuleValues`'s own
    // final `findByPkOrFail` re-reads the (unmodified) fixture, which is enough to prove the
    // guard ran before any write, per TC-3/TC-4's own assertions on `created`.
    void model;
    return 1;
  }
}

class FakeSequelize {
  async transaction<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> {
    return fn({} as Transaction);
  }
}

class FakeAudit {
  async record(): Promise<void> {
    // Not this file's concern — `t127`/`t136`'s specs already assert audit wiring.
  }
  diff(before: unknown, after: unknown): Record<string, unknown> {
    return { before, after };
  }
}

// --- fixtures --------------------------------------------------------------------------------------

const MAKER = {
  id: 1,
  role: 'maker',
  tenantId: 10,
  countryId: 20,
  merchantId: null,
} as unknown as AuthenticatedUser;

const CAMPAIGN = { id: 500, tenantId: 10 } as unknown as TenantCampaign;

/** The tracker every fixture component below belongs to, except `OTHER_TRACKER_COMPONENT_ID`. */
const TRACKER_ID = 7;
const OTHER_TRACKER_ID = 8;

/** `sequence_order` 2 — the component every binding in this file is attached to. */
const OWN_COMPONENT_ID = 72;
const EARLIER_COMPONENT_ID = 71; // sequence_order 1
const LATER_COMPONENT_ID = 73; // sequence_order 3
const TIED_COMPONENT_ID = 74; // sequence_order 2, same as OWN_COMPONENT_ID
const OTHER_TRACKER_COMPONENT_ID = 999; // exists, but in OTHER_TRACKER_ID, not TRACKER_ID

const SIBLING_FIELD_KEY = 'targetComponentId';
const SIBLING_FIELD = {
  key: SIBLING_FIELD_KEY,
  label: 'Earlier step',
  type: 'select',
  required: true,
  valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' },
};

const RULE_ID = 900;
const EXISTING_BINDING_ID = 501;

function ruleWith(fields: readonly Record<string, unknown>[]): RuleMaster {
  return { id: RULE_ID, status: 'active', parameters: { fields } } as unknown as RuleMaster;
}

function build({
  fields = [SIBLING_FIELD],
  existingBinding = false,
}: { fields?: readonly Record<string, unknown>[]; existingBinding?: boolean } = {}) {
  const scoped = new FakeScoped();

  scoped.setRows(TenantCampaignTracker, [
    { id: 30, campaignId: CAMPAIGN.id, trackerId: TRACKER_ID, status: 'active' },
  ]);
  scoped.setRows(TrackerTrackerComponent, [
    { id: 40, trackerId: TRACKER_ID, componentId: EARLIER_COMPONENT_ID, sequenceOrder: 1 },
    { id: 41, trackerId: TRACKER_ID, componentId: OWN_COMPONENT_ID, sequenceOrder: 2 },
    { id: 42, trackerId: TRACKER_ID, componentId: LATER_COMPONENT_ID, sequenceOrder: 3 },
    { id: 43, trackerId: TRACKER_ID, componentId: TIED_COMPONENT_ID, sequenceOrder: 2 },
    {
      id: 44,
      trackerId: OTHER_TRACKER_ID,
      componentId: OTHER_TRACKER_COMPONENT_ID,
      sequenceOrder: 1,
    },
  ]);
  scoped.setRows(RuleMaster, [ruleWith(fields)]);
  scoped.setRows(
    TrackerComponentRule,
    existingBinding
      ? [
          {
            id: EXISTING_BINDING_ID,
            trackerComponentId: OWN_COMPONENT_ID,
            ruleId: RULE_ID,
            ruleVersionId: null,
            config: {},
            status: 'active',
          },
        ]
      : [],
  );

  const audit = new FakeAudit();
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
  return { service, scoped, audit };
}

function bindDto(
  targetComponentId: number | string,
  overrides: Partial<BindComponentRuleDto> = {},
): BindComponentRuleDto {
  return {
    componentId: OWN_COMPONENT_ID,
    ruleId: RULE_ID,
    values: { [SIBLING_FIELD_KEY]: targetComponentId },
    ...overrides,
  } as BindComponentRuleDto;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

// --- bindRule --------------------------------------------------------------------------------------

describe('T-124/T-141 · POST /campaigns/:id/rules — the sibling-order guard', () => {
  it('TC-1: an earlier sibling is accepted (201)', async () => {
    const { service, scoped } = build();

    const binding = await service.bindRule(MAKER, CAMPAIGN, bindDto(EARLIER_COMPONENT_ID));

    expect(binding.config).toEqual({ [SIBLING_FIELD_KEY]: String(EARLIER_COMPONENT_ID) });
    expect(scoped.created.map((row) => row.model)).toEqual([TrackerComponentRule.name]);
  });

  it('TC-2: a later sibling is refused (400), and nothing is written', async () => {
    const { service, scoped } = build();

    const error = await caught(service.bindRule(MAKER, CAMPAIGN, bindDto(LATER_COMPONENT_ID)));

    expect(error).toBeInstanceOf(SiblingComponentNotEarlierError);
    expect(scoped.created).toEqual([]);
  });

  it('TC-3: a tied sequence_order is refused — "strictly earlier" excludes a tie', async () => {
    const { service, scoped } = build();

    const error = await caught(service.bindRule(MAKER, CAMPAIGN, bindDto(TIED_COMPONENT_ID)));

    expect(error).toBeInstanceOf(SiblingComponentNotEarlierError);
    expect(scoped.created).toEqual([]);
  });

  it('TC-4: a self-reference is refused — the degenerate case of a tie against one’s own row', async () => {
    const { service, scoped } = build();

    const error = await caught(service.bindRule(MAKER, CAMPAIGN, bindDto(OWN_COMPONENT_ID)));

    expect(error).toBeInstanceOf(SiblingComponentNotEarlierError);
    expect(scoped.created).toEqual([]);
  });

  it('TC-5: a non-CONTEXT_LOOKUP field is unaffected — the guard never runs for it', async () => {
    const plainField = { key: 'note', label: 'Note', type: 'string', required: false };
    const { service, scoped } = build({ fields: [plainField] });

    const binding = await service.bindRule(
      MAKER,
      CAMPAIGN,
      bindDto(LATER_COMPONENT_ID, { values: { note: 'anything at all' } }),
    );

    expect(binding.config).toEqual({ note: 'anything at all' });
    expect(scoped.created).toHaveLength(1);
  });

  it('a CONTEXT_LOOKUP field from a different provider is unaffected — only SIBLING_COMPONENTS is guarded', async () => {
    const otherProviderField = {
      ...SIBLING_FIELD,
      valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'JOURNEY_COMPONENTS' },
    };
    const { service, scoped } = build({ fields: [otherProviderField] });

    // A "later" component id would be refused if this were mistaken for SIBLING_COMPONENTS.
    const binding = await service.bindRule(MAKER, CAMPAIGN, bindDto(LATER_COMPONENT_ID));

    expect(binding.config).toEqual({ [SIBLING_FIELD_KEY]: String(LATER_COMPONENT_ID) });
    expect(scoped.created).toHaveLength(1);
  });

  it('TC-6: a component that exists, but in a different tracker entirely, is refused', async () => {
    const { service, scoped } = build();

    const error = await caught(
      service.bindRule(MAKER, CAMPAIGN, bindDto(OTHER_TRACKER_COMPONENT_ID)),
    );

    expect(error).toBeInstanceOf(SiblingComponentNotEarlierError);
    expect(scoped.created).toEqual([]);
  });

  it('reports 400 with details naming the field and the refused component — not a bare refusal', async () => {
    const { service } = build();

    const error = (await caught(
      service.bindRule(MAKER, CAMPAIGN, bindDto(LATER_COMPONENT_ID)),
    )) as SiblingComponentNotEarlierError;

    expect(error.status).toBe(400);
    expect(error.code).toBe('SIBLING_COMPONENT_NOT_EARLIER');
    expect(error.details).toEqual([
      { field: `values.${SIBLING_FIELD_KEY}`, code: `COMPONENT_${LATER_COMPONENT_ID}` },
    ]);
  });

  it('an omitted optional SIBLING_COMPONENTS value has nothing to check', async () => {
    const optionalField = { ...SIBLING_FIELD, required: false };
    const { service, scoped } = build({ fields: [optionalField] });

    const binding = await service.bindRule(
      MAKER,
      CAMPAIGN,
      bindDto(EARLIER_COMPONENT_ID, { values: {} }),
    );

    expect(binding.config).toEqual({});
    expect(scoped.created).toHaveLength(1);
  });
});

// --- updateRuleValues --------------------------------------------------------------------------------

describe('T-124/T-141 · PATCH /campaigns/:id/rules/:bindingId — the same guard re-runs on edit', () => {
  it('accepts an edit that moves the pick to an earlier sibling', async () => {
    const { service } = build({ existingBinding: true });

    const binding = await service.updateRuleValues(MAKER, CAMPAIGN, EXISTING_BINDING_ID, {
      values: { [SIBLING_FIELD_KEY]: String(EARLIER_COMPONENT_ID) },
    });

    expect(binding.id).toBe(EXISTING_BINDING_ID);
  });

  it('refuses an edit that moves the pick to a later sibling — a second Maker mid-edit is exactly this case', async () => {
    const { service } = build({ existingBinding: true });

    const error = await caught(
      service.updateRuleValues(MAKER, CAMPAIGN, EXISTING_BINDING_ID, {
        values: { [SIBLING_FIELD_KEY]: String(LATER_COMPONENT_ID) },
      }),
    );

    expect(error).toBeInstanceOf(SiblingComponentNotEarlierError);
  });
});
