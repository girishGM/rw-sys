/**
 * T-136 — the **server side** of the value-source fix: `PATCH /campaigns/:id/rules/:bindingId`
 * must accept the value a Maker picked from a provider-sourced dropdown (T-122's `valueSource`,
 * resolved by T-123's lookup), and must keep naming the offending parameter when it refuses one.
 *
 * ### Why this exists as its own file
 *
 * `campaign.schema.spec.ts` proves `buildRuleValueSchema` itself. This proves the **wiring**: that
 * the save path really is built from that function rather than from a second, drifting copy, and
 * that a rejection still arrives shaped as `details[].field === 'values.<parameterKey>'`. That
 * detail shape is not decoration — `CampaignWizardPage#ruleValueFieldErrors` (the other half of
 * this task) maps errors onto form controls with it, so a change here would silently un-fix the
 * SPA half while every front-end test kept passing against its own fixture.
 *
 * The defect was worth catching on this side specifically. `bindings.service.ts` calls the shared
 * schema on the way *in*, so before the fix a `curl` — and the SPA, and the AI agent's own
 * re-validation — all refused a legitimate component id chosen from T-123's dropdown with a 400
 * naming a sentinel value no JSON body can even carry.
 *
 * ### What is faked, and what deliberately is not
 *
 * The repository is faked (`FakeScoped`, the same shape as this folder's other unit specs); **no
 * decision is**. The values are parsed by the real shared `buildRuleValueSchema`, so "is this
 * value acceptable?" is answered here by exactly the code that answers it in production. What the
 * doubles stand in for is Postgres returning rows — which T-013 proves exhaustively and which
 * these cases are not about. Membership and tenancy are likewise out of scope here:
 * `campaigns.e2e-spec.ts` (TC-21q, TC-15) covers them against the real database.
 *
 * ### T-142 — why this file's double had to start applying `where`
 *
 * As first written, `FakeScoped#listAll` ignored its `where` argument and returned the whole
 * scripted array for a model, and the fixture held exactly **one** `TrackerTrackerComponent` row.
 * That was survivable only for as long as nothing looked a *second*, different component up. It
 * stopped being survivable when T-141 restored T-124's `SIBLING_COMPONENTS` circular-dependency
 * guard (wiped from the working tree by a `git reset` ~10 hours before this file was authored, so
 * both cases below were written and reviewed in a guard-absent world): `updateRuleValues` now
 * issues two structurally different `TrackerTrackerComponent` reads per call — the binding's own
 * link (`assertComponentInCampaign`), then the picked target's — and a `where`-blind double
 * answered both with the same row zero. The guard then compared component 11's `sequence_order`
 * against *itself*, read the tie as a self-reference and threw `SIBLING_COMPONENT_NOT_EARLIER`
 * where these cases expect a save. The guard was right; the fixture was lying to it.
 *
 * So the double below now genuinely filters (equality + `Op.in`, the same shapes
 * `t141-sibling-circular-dependency.spec.ts`'s own double supports and the only ones this path
 * issues), and the fixture carries three sibling rows instead of one — an earlier legal target, a
 * later illegal one, and the binding's own. The alternative considered and rejected was to keep
 * the blind double and simply add a row: with `where` ignored, *which* row answers a lookup is
 * decided by array position, so both reads would still collide and the cases would pass or fail
 * for reasons unrelated to the rule under test. `it('TC-3: …')` below pins the filtering itself,
 * and the `SIBLING_COMPONENT_NOT_EARLIER` case pins that the guard is genuinely reached from this
 * fixture — without that pair, this file could quietly stop exercising the guard again.
 */
import {
  Op,
  type FindOptions,
  type Model,
  type ModelStatic,
  type Transaction,
  type UpdateOptions,
} from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type { CampaignAuditService } from '@/modules/campaigns/campaign-audit.service';
import type { TenantCampaign } from '@/database/models';
import {
  RuleMaster,
  TenantCampaignTracker,
  TrackerComponentRule,
  TrackerTrackerComponent,
} from '@/database/models';
import { ValidationFailedError } from '@/common/errors/app-error';
import { BindingsService } from '@/modules/campaigns/bindings.service';
import { SiblingComponentNotEarlierError } from '@/modules/campaigns/campaigns.errors';

// --- doubles -------------------------------------------------------------------------------------

interface RecordedUpdate {
  readonly model: string;
  readonly values: Record<string, unknown>;
}

/**
 * `scoped-lookup.ts#byIdOrNull` (used by `parametersForBinding`) keys its `where` on
 * `model.primaryKeyAttribute`, which Sequelize populates in `Model.init()` — something only a
 * bootstrapped `Sequelize` instance runs, and no unit spec in this folder has one. Outside one it
 * is `undefined`, so the clause arrives as a literal `{ undefined: id }`. Mapping that one key
 * back onto `id` is what lets a genuinely-filtering double coexist with `byIdOrNull` at all.
 * (Same treatment, same reason, as `t141-sibling-circular-dependency.spec.ts`'s own double; kept
 * a private local rather than shared, because that file belongs to another task — R9 — and one
 * small duplicated matcher is cheaper than a shared test helper neither task owns.)
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

/** Matches a fixture row against a `where` clause — equality and `Op.in`, the only shapes the
 * paths under test issue. Anything richer would only make this double harder to trust. */
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
 * Answers `listAll`/`findByPkOrFail` from a per-model script and records every `update`.
 *
 * `listAll` genuinely applies `where` and `limit` (T-142 — see this file's header): the save path
 * reads `tracker_tracker_components` twice with different clauses, and a double that answered
 * both with row zero made the sibling-order guard compare a component against itself.
 */
class FakeScoped {
  readonly updates: RecordedUpdate[] = [];
  private readonly rows = new Map<string, Record<string, unknown>[]>();

  setRows(model: ModelStatic<Model>, rows: readonly unknown[]): this {
    this.rows.set(model.name, [...(rows as Record<string, unknown>[])]);
    return this;
  }

  async listAll<M extends Model>(model: ModelStatic<M>, options: FindOptions = {}): Promise<M[]> {
    const matching = (this.rows.get(model.name) ?? []).filter((row) =>
      matchesWhere(row, options.where),
    );
    const limited = options.limit === undefined ? matching : matching.slice(0, options.limit);
    return limited as unknown as M[];
  }

  async findByPkOrFail<M extends Model>(model: ModelStatic<M>, id: number): Promise<M> {
    const row = (this.rows.get(model.name) ?? []).find((candidate) => candidate['id'] === id);
    if (row === undefined) throw new Error(`no scripted ${model.name} row with id ${id}`);
    return row as unknown as M;
  }

  async update(
    model: ModelStatic<Model>,
    values: unknown,
    _options: UpdateOptions,
  ): Promise<number> {
    this.updates.push({ model: model.name, values: values as Record<string, unknown> });
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
  diff(before: unknown, after: unknown): Record<string, unknown> {
    return { before, after };
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

const BINDING_ID = 501;
const TRACKER_ID = 1;

/** The component this binding sits on — `sequence_order` 2, so exactly one sibling precedes it. */
const COMPONENT_ID = 11;

/** A **strictly earlier** sibling (`sequence_order` 1): the legal pick, and the id every accepting
 * case below sends. Deliberately not `COMPONENT_ID`, so a `where`-blind double cannot answer the
 * target lookup with the binding's own row and still look correct. */
const EARLIER_COMPONENT_ID = 4321;

/** A **later** sibling (`sequence_order` 3): the illegal pick T-124's guard exists to refuse. */
const LATER_COMPONENT_ID = 4322;

/** The rule the binding points at, with whatever `parameters` meta-schema the case needs. */
function ruleWith(fields: readonly Record<string, unknown>[]): RuleMaster {
  return {
    id: 101,
    ruleCode: 'RULE_COMP_AFTER_001',
    name: 'Completed after another step',
    status: 'active',
    parameters: { fields },
  } as unknown as RuleMaster;
}

/** One provider-sourced `select` — no `options` at all, which is the case T-136 could not save. */
const CONTEXT_SOURCED_FIELD = {
  key: 'targetComponentCode',
  label: 'Earlier step',
  type: 'select',
  required: true,
  valueSource: { kind: 'CONTEXT_LOOKUP', contextProvider: 'SIBLING_COMPONENTS' },
};

function build(fields: readonly Record<string, unknown>[]) {
  const scoped = new FakeScoped();
  scoped.setRows(TrackerComponentRule, [
    {
      id: BINDING_ID,
      trackerComponentId: COMPONENT_ID,
      ruleId: 101,
      ruleVersionId: null,
      config: {},
      status: 'active',
    },
  ]);
  scoped.setRows(TenantCampaignTracker, [
    { id: 1, trackerId: TRACKER_ID, campaignId: 500, status: 'active' },
  ]);
  // One journey, three steps. T-124's guard reads this set twice per save (own link, then the
  // picked target), so the rows must be tellable apart — see this file's header (T-142).
  scoped.setRows(TrackerTrackerComponent, [
    { id: 1, trackerId: TRACKER_ID, componentId: COMPONENT_ID, sequenceOrder: 2 },
    { id: 2, trackerId: TRACKER_ID, componentId: EARLIER_COMPONENT_ID, sequenceOrder: 1 },
    { id: 3, trackerId: TRACKER_ID, componentId: LATER_COMPONENT_ID, sequenceOrder: 3 },
  ]);
  scoped.setRows(RuleMaster, [ruleWith(fields)]);

  const audit = new FakeAudit();
  const service = new BindingsService(
    new FakeSequelize() as unknown as Sequelize,
    scoped as unknown as ScopedRepository,
    audit as unknown as CampaignAuditService,
  );
  return { service, scoped, audit };
}

/** The `config` written by the save, or `undefined` when nothing was written. */
function writtenConfig(scoped: FakeScoped): unknown {
  return scoped.updates.find((update) => update.model === TrackerComponentRule.name)?.values.config;
}

describe('T-136 · a provider-sourced rule value survives the binding save path', () => {
  it('TC-2: accepts the component id a Maker picked from the context-lookup dropdown', async () => {
    const { service, scoped } = build([CONTEXT_SOURCED_FIELD]);

    await service.updateRuleValues(MAKER, CAMPAIGN, BINDING_ID, {
      values: { targetComponentCode: String(EARLIER_COMPONENT_ID) },
    });

    // Before the fix this threw a 400 whose only detail named `values.targetComponentCode` —
    // for a value the server itself had offered one request earlier.
    expect(writtenConfig(scoped)).toEqual({
      targetComponentCode: String(EARLIER_COMPONENT_ID),
    });
  });

  it('stores a numeric provider value in its string form — one shape per value in `config`', async () => {
    const { service, scoped } = build([CONTEXT_SOURCED_FIELD]);

    await service.updateRuleValues(MAKER, CAMPAIGN, BINDING_ID, {
      values: { targetComponentCode: EARLIER_COMPONENT_ID },
    });

    expect(writtenConfig(scoped)).toEqual({
      targetComponentCode: String(EARLIER_COMPONENT_ID),
    });
  });

  /**
   * T-142's regression pin, half one: the schema accepting a provider-sourced value must not be
   * mistaken for the guard being switched off. If `assertNoCircularSiblingDependency` were
   * removed from `updateRuleValues` again (T-141's exact regression), or if this file's fixture
   * drifted back to a shape the guard cannot see past, this case goes green-to-red immediately —
   * whereas the two accepting cases above would go *green* under a missing guard, which is
   * precisely how the broken fixture survived review the first time.
   */
  it('TC-3: still refuses a later sibling — a value the schema accepts but the guard must not', async () => {
    const { service, scoped } = build([CONTEXT_SOURCED_FIELD]);

    const error = await service
      .updateRuleValues(MAKER, CAMPAIGN, BINDING_ID, {
        values: { targetComponentCode: String(LATER_COMPONENT_ID) },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SiblingComponentNotEarlierError);
    expect(writtenConfig(scoped)).toBeUndefined();
  });

  /**
   * T-142's regression pin, half two: the double's own filtering, asserted directly.
   *
   * The two accepting cases above only pass because `listAll` can tell the binding's own link row
   * from the picked target's. That is a property of the *fixture*, not of any production code, so
   * nothing else in this file would fail if it were quietly reverted — and reverting it is exactly
   * what broke this spec. Asserting it here means the next person to simplify this double gets a
   * failure that names the reason, instead of two mysterious 400s in unrelated cases.
   */
  it('TC-3: the repository double filters `where`, so the two sibling lookups cannot collide', async () => {
    const { scoped } = build([CONTEXT_SOURCED_FIELD]);

    const own = await scoped.listAll(TrackerTrackerComponent, {
      where: { componentId: COMPONENT_ID, trackerId: { [Op.in]: [TRACKER_ID] } },
    });
    const target = await scoped.listAll(TrackerTrackerComponent, {
      where: { componentId: EARLIER_COMPONENT_ID, trackerId: TRACKER_ID },
    });

    expect(own).toHaveLength(1);
    expect(target).toHaveLength(1);
    expect(own[0]).not.toBe(target[0]);
    expect(own[0]).toEqual(
      expect.objectContaining({ componentId: COMPONENT_ID, sequenceOrder: 2 }),
    );
    expect(target[0]).toEqual(
      expect.objectContaining({ componentId: EARLIER_COMPONENT_ID, sequenceOrder: 1 }),
    );

    // A component that is not on this journey resolves to nothing at all, rather than to row zero.
    await expect(
      scoped.listAll(TrackerTrackerComponent, { where: { componentId: 99999 } }),
    ).resolves.toEqual([]);
  });

  it('TC-4: still refuses a value the schema cannot accept, naming the parameter that failed', async () => {
    const { service, scoped } = build([CONTEXT_SOURCED_FIELD]);

    // The detail shape the SPA maps onto the offending control — `CampaignWizardPage`'s own
    // `ruleValueFieldErrors` splits exactly this prefix off.
    const error = await service
      .updateRuleValues(MAKER, CAMPAIGN, BINDING_ID, { values: { targetComponentCode: '' } })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ValidationFailedError);
    expect((error as ValidationFailedError).status).toBe(400);
    expect((error as ValidationFailedError).details).toEqual([
      expect.objectContaining({ field: 'values.targetComponentCode' }),
    ]);
    expect(writtenConfig(scoped)).toBeUndefined();
  });

  it('TC-4: a plain fixed-list select is unaffected — its options are still enforced server-side', async () => {
    const fixed = {
      key: 'txnType',
      label: 'Transaction type',
      type: 'select',
      required: true,
      options: ['purchase', 'refund'],
    };

    const accepted = build([fixed]);
    await accepted.service.updateRuleValues(MAKER, CAMPAIGN, BINDING_ID, {
      values: { txnType: 'purchase' },
    });
    expect(writtenConfig(accepted.scoped)).toEqual({ txnType: 'purchase' });

    const refused = build([fixed]);
    await expect(
      refused.service.updateRuleValues(MAKER, CAMPAIGN, BINDING_ID, {
        values: { txnType: 'anything-else' },
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect(writtenConfig(refused.scoped)).toBeUndefined();
  });
});
