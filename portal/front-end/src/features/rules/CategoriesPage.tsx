/**
 * T-107 — `/rule-categories`: Rule Categories & Sub-Categories management.
 *
 * Reached through `router.tsx`'s `RequirePermission entity="rule_category" action="view"`
 * guard — every role can view (T-106 permission seed), only `super_admin` sees the create/edit
 * controls (`CategoryManager`'s own `canWriteCategory`/`canWriteSubCategory`).
 *
 * T-117 — this screen used to be its own flat-table-plus-four-modals implementation
 * (`AddCategoryModal`/`EditCategoryModal`/`AddSubCategoryModal`/`EditSubCategoryModal`, all
 * removed by this change). It now renders the shared, kind-agnostic two-pane
 * `features/shared/CategoryManager`, the same component `../rewards/RewardCategoriesPage.tsx`
 * renders with `kind="reward"` — see that component's own file banner for why this replaced the
 * old layout, and this task's completion report for the file this task's own task file named
 * (`RuleCategoriesPage.tsx`) versus the one it actually retrofitted (this file, T-107's real
 * name).
 */
import { CategoryManager } from '../shared/CategoryManager';
import { PageHeader } from '../../components/PageHeader';

export function CategoriesPage() {
  return (
    <div className="p-6">
      <PageHeader
        title="Categories"
        description="Rule categories and sub-categories — the grouping every rule master is created under."
      />
      <CategoryManager kind="rule" />
    </div>
  );
}
