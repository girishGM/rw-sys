/**
 * T-137 — the `listRuleOptions()` ↔ `ruleOptionSchema` contract, asserted end to end.
 *
 * ### Why this file exists even though the reported defect no longer reproduces
 *
 * T-137 was filed against the same root cause as T-138 (`ruleOptionSchema` and
 * `listRuleOptions()` both missing `categoryId`/`subCategoryId` while their consumers already
 * read them). T-138 landed first and fixed both halves, so T-137's symptom — a red workspace
 * typecheck in `ComponentRulesStep.tsx` and `lookup-tool.spec.ts` — is gone. Per the task file,
 * a defect that stops reproducing is not silently closed: it gets a regression test that would
 * catch it coming back.
 *
 * The two specs T-138 left behind each prove one half against a *hand-written literal*:
 *
 *  - `packages/shared/src/campaign.schema.spec.ts` proves the **shape** `ruleOptionSchema`
 *    accepts, using a `VALID_OPTION` object literal written by hand.
 *  - `test/campaigns/t138-rule-option-category-ids.spec.ts` proves the **wiring** — that
 *    `listRuleOptions()` resolves the real ids — and says so explicitly: *"No schema validation
 *    happens here either."*
 *
 * Nothing asserts the join. That gap is not academic: it is precisely how the original
 * regression survived review. Each side agreed with its own fixture, the fixtures agreed with
 * nobody, and the mismatch only surfaced as a compile error in a third file. This suite closes
 * it by pushing the **service's real output** through the **exact validator the browser runs**.
 *
 * ### Asserting the observable property (AGENT-PROTOCOL §3)
 *
 * `front-end/src/features/campaigns/api.ts:215` parses every `GET /campaigns/:id/rule-options`
 * response with `ruleOptionListEnvelopeSchema` before the rule picker sees it. That parse — not
 * any string in this repo — is what ultimately judges the endpoint: if the service omits an id,
 * emits `undefined`, or drifts a key name, the picker fails at runtime in the user's browser
 * with a validation error, however green the two half-tests are. So the assertion here is
 * `ruleOptionListEnvelopeSchema.safeParse(<real service output>)`, not a field-by-field
 * comparison against another literal, which would just be a third fixture to drift.
 *
 * Because the schema is `.strict()`, this catches divergence in *both* directions: a field the
 * service drops (missing required key) and a field the service adds that the schema does not
 * know about (unrecognised key).
 *
 * ### What is faked, and what deliberately is not
 *
 * The repository is faked (`FakeScoped`, the same double `t138-rule-option-category-ids.spec.ts`
 * and T-127's suites use) — this is a unit test of the service's own composition against the
 * shared contract, not of `ScopedRepository`'s country scoping, which T-013 and the campaigns
 * e2e suite already prove. The schema is emphatically **not** faked: it is imported from
 * `@reward-portal/shared`, the same module the front-end imports.
 */
import type { FindOptions, Model, ModelStatic } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { ruleOptionListEnvelopeSchema, ruleOptionSchema } from '@reward-portal/shared';
import type { RuleOption } from '@reward-portal/shared';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import type { CampaignAuditService } from '@/modules/campaigns/campaign-audit.service';
import type { PromoCodeServiceClient } from '@/modules/promo-code-integration/promo-code-service.client';
import {
  RuleCategory,
  RuleMaster,
  RuleSubCategory,
  RuleVersion,
  RuleVersionCountryAssignment,
} from '@/database/models';
import { BindingsService } from '@/modules/campaigns/bindings.service';

// --- compile-time pin ----------------------------------------------------------------------

/**
 * TC-3 (type half). T-137's reported symptom was a *compile* error, not a failing assertion:
 * `TS2339: Property 'categoryId' does not exist` in `ComponentRulesStep.tsx`, `TS2353` in
 * `lookup-tool.spec.ts`. A runtime test cannot express that. This alias reproduces the same
 * failure class inside this suite — drop either key from `ruleOptionSchema` and `Pick<>` stops
 * satisfying its `keyof RuleOption` constraint, so `npm run typecheck` goes red here rather
 * than only in files this task does not own.
 */
type RuleOptionCategoryIds = Pick<RuleOption, 'categoryId' | 'subCategoryId'>;

/** Both ids are non-nullable integers — not `number | null`, unlike the `*Name` display labels. */
const CATEGORY_IDS_ARE_REQUIRED_NUMBERS: RuleOptionCategoryIds = {
  categoryId: 7,
  subCategoryId: 42,
};

// --- doubles -------------------------------------------------------------------------------

/** Answers `listAll` from a per-model script — this suite only ever reads. */
class FakeScoped {
  private readonly rows = new Map<string, unknown[]>();

  setRows(model: ModelStatic<Model>, rows: readonly unknown[]): this {
    this.rows.set(model.name, [...rows]);
    return this;
  }

  async listAll<M extends Model>(model: ModelStatic<M>, _options: FindOptions = {}): Promise<M[]> {
    return (this.rows.get(model.name) ?? []) as M[];
  }
}

// --- fixtures ------------------------------------------------------------------------------

function rule(id: number, subCategoryId: number, name: string): RuleMaster {
  return {
    id,
    ruleCode: `RULE_${id}`,
    name,
    subCategoryId,
    status: 'active',
    parameters: { fields: [] },
  } as unknown as RuleMaster;
}

function subCategory(id: number, categoryId: number, name: string): RuleSubCategory {
  return { id, categoryId, name } as unknown as RuleSubCategory;
}

function category(id: number, name: string): RuleCategory {
  return { id, name } as unknown as RuleCategory;
}

function build({
  rules,
  subCategories,
  categories,
}: {
  rules: readonly RuleMaster[];
  subCategories: readonly RuleSubCategory[];
  categories: readonly RuleCategory[];
}) {
  const scoped = new FakeScoped();
  scoped.setRows(RuleMaster, rules);
  scoped.setRows(RuleSubCategory, subCategories);
  scoped.setRows(RuleCategory, categories);
  scoped.setRows(RuleVersionCountryAssignment, []);
  scoped.setRows(RuleVersion, []);

  return new BindingsService(
    {} as unknown as Sequelize,
    scoped as unknown as ScopedRepository,
    {} as unknown as CampaignAuditService,
    // T-166 — no path exercised in this file supplies a `promoCodeConfig`, so none of them may
    // reach promo-code-service. A double that throws states that as an assertion rather than
    // leaving it to be noticed: if an attach here ever starts binding, this file fails loudly.
    {
      bind: (): Promise<never> =>
        Promise.reject(new Error('T-166: no promo-code-service bind is expected on this path')),
    } as unknown as PromoCodeServiceClient,
  );
}

/** Two rules under different categories — enough for the envelope to be more than one row. */
function realisticService() {
  return build({
    rules: [rule(1, 42, 'Minimum spend'), rule(2, 99, 'Transaction count')],
    subCategories: [subCategory(42, 7, 'Spend thresholds'), subCategory(99, 8, 'Counts')],
    categories: [category(7, 'Component rules'), category(8, 'Aggregate rules')],
  });
}

describe('T-137 · listRuleOptions() output satisfies the shared ruleOptionSchema contract', () => {
  it('TC-2: the real service output parses under the exact envelope schema the front-end runs', async () => {
    const options = await realisticService().listRuleOptions();

    // `api.ts` wraps the rows in `{ data }` before parsing — mirror that exactly.
    const result = ruleOptionListEnvelopeSchema.safeParse({ data: options });

    // Surface the real zod complaint on failure instead of a bare `false`.
    expect(result.success ? null : result.error.issues).toBeNull();
    expect(result.success).toBe(true);
  });

  it('TC-3: every row carries categoryId/subCategoryId as integers that survive the parse', async () => {
    const options = await realisticService().listRuleOptions();
    const parsed = ruleOptionListEnvelopeSchema.parse({ data: options });

    expect(parsed.data).toHaveLength(2);
    for (const option of parsed.data) {
      expect(Number.isInteger(option.categoryId)).toBe(true);
      expect(Number.isInteger(option.subCategoryId)).toBe(true);
    }
    // The ids must be each row's own, not the first row's repeated — the cross-talk case.
    expect(parsed.data.map((option) => [option.categoryId, option.subCategoryId])).toEqual([
      [7, 42],
      [8, 99],
    ]);
  });

  it('TC-3: a single option, taken straight from the service, parses under ruleOptionSchema itself', async () => {
    const [option] = await build({
      rules: [rule(1, 42, 'Minimum spend')],
      subCategories: [subCategory(42, 7, 'Spend thresholds')],
      categories: [category(7, 'Component rules')],
    }).listRuleOptions();

    const result = ruleOptionSchema.safeParse(option);

    expect(result.success ? null : result.error.issues).toBeNull();
    expect(result.success).toBe(true);
  });

  it('TC-4: the orphaned-sub-category fallback still produces a payload the browser accepts', async () => {
    // A rule whose `sub_category_id` points at a missing row is a data-integrity fault the
    // endpoint cannot repair — but it must still emit a *parseable* row rather than `undefined`,
    // or one bad rule takes the whole picker down for every other rule in the response.
    const options = await build({
      rules: [rule(1, 404, 'Orphaned rule')],
      subCategories: [],
      categories: [],
    }).listRuleOptions();

    const result = ruleOptionListEnvelopeSchema.safeParse({ data: options });

    expect(result.success ? null : result.error.issues).toBeNull();
    expect(options[0]?.categoryId).toBe(0);
    expect(options[0]?.subCategoryId).toBe(404);
  });

  it('TC-4: an empty rule list still yields a valid (empty) envelope', async () => {
    const options = await build({ rules: [], subCategories: [], categories: [] }).listRuleOptions();

    expect(ruleOptionListEnvelopeSchema.safeParse({ data: options }).success).toBe(true);
    expect(options).toEqual([]);
  });

  it('guards the guard: the envelope really does reject a row with the ids stripped', async () => {
    // Without this, the suite above could pass against a schema that had quietly stopped
    // requiring the ids — the exact regression T-137/T-138 were filed for. Stripping them from
    // an otherwise-real row must be rejected, which proves the parse is load-bearing.
    const [option] = await realisticService().listRuleOptions();
    // Deletion, not destructuring — the same convention `campaign.schema.spec.ts` uses for this,
    // so no unused rest-sibling lint noise.
    const withoutIds: Record<string, unknown> = { ...option };
    delete withoutIds.categoryId;
    delete withoutIds.subCategoryId;

    const result = ruleOptionListEnvelopeSchema.safeParse({ data: [withoutIds] });

    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['data.0.categoryId', 'data.0.subCategoryId']));
  });

  it('the compile-time pin holds the ids at non-nullable numbers', () => {
    expect(CATEGORY_IDS_ARE_REQUIRED_NUMBERS).toEqual({ categoryId: 7, subCategoryId: 42 });
  });
});
