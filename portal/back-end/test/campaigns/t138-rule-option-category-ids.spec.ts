/**
 * T-138 — `listRuleOptions()` must populate `categoryId`/`subCategoryId`, not just their display
 * names.
 *
 * ### Why this exists as its own file
 *
 * T-112's own implementation notes 1-2 named this exact wiring — `bindings.service.ts`'s
 * `listRuleOptions()` adding `categoryId: category.id` / `subCategoryId: subCategory.id` to its
 * returned object literal, and `campaign.schema.ts`'s `ruleOptionSchema` requiring both — and T-112
 * was reviewed and marked `done` on the strength of it. T-113's whole-workspace typecheck later
 * found neither change on disk: `.git/logs/HEAD` shows an uncommitted-work reset sitting after the
 * last real commit, consistent with this half of T-112 being wiped while its front-end consumer
 * (already reading `.categoryId`/`.subCategoryId`, `ComponentRulesStep.tsx`) survived because it
 * was re-authored afterwards. `campaign.schema.spec.ts`'s new `ruleOptionSchema` block proves the
 * **shape**; this file proves the **wiring** — that `listRuleOptions()` actually resolves each
 * rule's real category/sub-category ids rather than, say, always emitting `0` or leaking the wrong
 * rule's ids when more than one rule/category is in play.
 *
 * ### What is faked, and what deliberately is not
 *
 * The repository is faked (`FakeScoped`, same shape as T-127's own `test/campaigns/*.spec.ts`
 * doubles) — this is a unit test of `listRuleOptions()`'s own composition (id lookups, `Map`
 * construction, the object literal), not of `ScopedRepository`'s country-scoping, which T-013 and
 * `bindings.service.ts`'s real e2e coverage already prove. No schema validation happens here either
 * — `campaign.schema.spec.ts` owns proving the shape `ruleOptionSchema` accepts.
 */
import type { FindOptions, Model, ModelStatic } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import type { CampaignAuditService } from '@/modules/campaigns/campaign-audit.service';
import {
  RuleCategory,
  RuleMaster,
  RuleSubCategory,
  RuleVersion,
  RuleVersionCountryAssignment,
} from '@/database/models';
import { BindingsService } from '@/modules/campaigns/bindings.service';

// --- doubles -------------------------------------------------------------------------------------

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

// --- fixtures --------------------------------------------------------------------------------

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

/** No live-assignment fixtures needed here — `ruleVersionId`/`ruleVersionNo` are out of scope. */
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

  const service = new BindingsService(
    {} as unknown as Sequelize,
    scoped as unknown as ScopedRepository,
    {} as unknown as CampaignAuditService,
  );
  return { service };
}

describe('T-138 · listRuleOptions() populates categoryId/subCategoryId', () => {
  it('TC-2/TC-3: every option carries the real ids of its own category/sub-category', async () => {
    const { service } = build({
      rules: [rule(1, 42, 'Minimum spend')],
      subCategories: [subCategory(42, 7, 'Spend thresholds')],
      categories: [category(7, 'Component rules')],
    });

    const [option] = await service.listRuleOptions();

    expect(option?.categoryId).toBe(7);
    expect(option?.subCategoryId).toBe(42);
    // The names travel alongside the ids, unchanged by this fix (T-138 is additive).
    expect(option?.categoryName).toBe('Component rules');
    expect(option?.subCategoryName).toBe('Spend thresholds');
  });

  it('TC-4: two rules under different categories each carry their own ids — no cross-talk between rows', async () => {
    const { service } = build({
      rules: [rule(1, 42, 'Minimum spend'), rule(2, 99, 'Transaction count')],
      subCategories: [subCategory(42, 7, 'Spend thresholds'), subCategory(99, 8, 'Counts')],
      categories: [category(7, 'Component rules'), category(8, 'Aggregate rules')],
    });

    const byRuleId = new Map(
      (await service.listRuleOptions()).map((option) => [option.ruleId, option]),
    );

    expect(byRuleId.get(1)).toMatchObject({ categoryId: 7, subCategoryId: 42 });
    expect(byRuleId.get(2)).toMatchObject({ categoryId: 8, subCategoryId: 99 });
  });

  it('a rule whose sub-category id does not resolve still returns a value (0), not undefined — the schema requires an int either way', async () => {
    const { service } = build({
      rules: [rule(1, 404, 'Orphaned rule')],
      subCategories: [],
      categories: [],
    });

    const [option] = await service.listRuleOptions();

    expect(option?.categoryId).toBe(0);
    expect(option?.subCategoryId).toBe(404); // rule.subCategoryId is always known — it's the FK.
    expect(option?.categoryName).toBeNull();
    expect(option?.subCategoryName).toBeNull();
  });

  it('an empty rule list returns an empty array without touching the category/sub-category lookups', async () => {
    const { service } = build({ rules: [], subCategories: [], categories: [] });

    await expect(service.listRuleOptions()).resolves.toEqual([]);
  });
});
