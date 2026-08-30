/**
 * T-117 — `/reward-categories`: Reward Categories & Sub-Categories management.
 *
 * T-116 built the CRUD endpoints (`reward-categories.controller.ts`) and permission entities
 * (`reward_category`/`reward_sub_category`) with nothing on the front end to consume them —
 * this is that screen, reached through `router.tsx`'s
 * `RequirePermission entity="reward_category" action="view"` guard (every role can view, only
 * `super_admin` sees the create/edit controls). It renders the same shared, kind-agnostic
 * `features/shared/CategoryManager` `../rules/CategoriesPage.tsx` uses with `kind="rule"`, just
 * with `kind="reward"` — see that component's own file banner for why one component serves both.
 *
 * A reward category can legitimately have **zero** sub-categories (T-116's own scope note:
 * Points never needs one) — `CategoryManager` already renders that as a plain empty state, not
 * an error, for `kind: 'reward'` specifically.
 */
import { CategoryManager } from '../shared/CategoryManager';
import { PageHeader } from '../../components/PageHeader';

export function RewardCategoriesPage() {
  return (
    <div className="p-6">
      <PageHeader
        title="Categories"
        description="Reward categories and sub-categories — the grouping every reward master is created under. Some categories (e.g. Points) may have none."
      />
      <CategoryManager kind="reward" />
    </div>
  );
}
