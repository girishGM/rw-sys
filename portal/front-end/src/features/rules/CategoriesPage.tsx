/**
 * T-107 — `/rule-categories`: Rule Categories & Sub-Categories management.
 *
 * Closes the gap `T-106`'s own task file names: categories/sub-categories were read-only
 * reference data with no create/edit screen anywhere. Reached through `router.tsx`'s
 * `RequirePermission entity="rule_category" action="view"` guard — every role can view (T-106
 * permission seed), only `super_admin` sees the create/edit controls, same two-control pattern
 * `RulesListPage.tsx`'s own header documents.
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { RuleCategory, RuleSubCategory } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { Skeleton } from '../../components/Skeleton';
import { useBootstrap } from '../../auth/useBootstrap';
import { AddCategoryModal } from './AddCategoryModal';
import { EditCategoryModal } from './EditCategoryModal';
import { AddSubCategoryModal } from './AddSubCategoryModal';
import { EditSubCategoryModal } from './EditSubCategoryModal';
import { useRuleCategoriesQuery, useRuleSubCategoriesQuery } from './api';

export function CategoriesPage() {
  const { hasPermission } = useBootstrap();
  const canWrite = hasPermission('rule_category', 'create');

  const categoriesQuery = useRuleCategoriesQuery();
  const subCategoriesQuery = useRuleSubCategoriesQuery();

  const [addCategoryOpen, setAddCategoryOpen] = useState(false);
  const [addSubCategoryOpen, setAddSubCategoryOpen] = useState(false);
  const [addSubCategoryFor, setAddSubCategoryFor] = useState<number | undefined>(undefined);
  const [editCategory, setEditCategory] = useState<RuleCategory | null>(null);
  const [editSubCategory, setEditSubCategory] = useState<RuleSubCategory | null>(null);

  const categories = categoriesQuery.data ?? [];
  const subCategories = subCategoriesQuery.data ?? [];

  const isLoading = categoriesQuery.isLoading || subCategoriesQuery.isLoading;

  return (
    <div className="p-6">
      <PageHeader
        title="Categories"
        description="Rule categories and sub-categories — the grouping every rule master is created under."
        actions={
          canWrite && (
            <Button type="button" onClick={() => setAddCategoryOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Add category
            </Button>
          )
        }
      />

      {isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : categories.length === 0 ? (
        <p className="text-sm text-slate-500">No categories yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {categories.map((category) => {
            const subs = subCategories.filter((sc) => sc.categoryId === category.id);
            return (
              <div
                key={category.id}
                className="rounded-card border border-slate-200 bg-white shadow-sm"
              >
                <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <code className="text-sm font-medium text-slate-800">
                      {category.categoryCode}
                    </code>
                    <span className="text-sm text-slate-600">{category.name}</span>
                    <Badge tone={category.status === 'active' ? 'success' : 'slate'}>
                      {category.status}
                    </Badge>
                  </div>
                  {canWrite && (
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setAddSubCategoryFor(category.id);
                          setAddSubCategoryOpen(true);
                        }}
                      >
                        <Plus className="size-4" aria-hidden="true" />
                        Sub-category
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setEditCategory(category)}
                      >
                        Edit
                      </Button>
                    </div>
                  )}
                </div>
                <div className="px-4 py-2">
                  {subs.length === 0 ? (
                    <p className="py-2 text-sm text-slate-400">No sub-categories yet.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <tbody>
                        {subs.map((sub) => (
                          <tr key={sub.id} className="border-b border-slate-50 last:border-none">
                            <td className="py-2 pr-4">
                              <code className="text-slate-700">{sub.subCategoryCode}</code>
                            </td>
                            <td className="py-2 pr-4 text-slate-600">{sub.name}</td>
                            <td className="py-2 pr-4">
                              <Badge tone={sub.status === 'active' ? 'success' : 'slate'}>
                                {sub.status}
                              </Badge>
                            </td>
                            <td className="py-2 text-right">
                              {canWrite && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setEditSubCategory(sub)}
                                >
                                  Edit
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AddCategoryModal open={addCategoryOpen} onClose={() => setAddCategoryOpen(false)} />
      <AddSubCategoryModal
        open={addSubCategoryOpen}
        onClose={() => {
          setAddSubCategoryOpen(false);
          setAddSubCategoryFor(undefined);
        }}
        categories={categories}
        defaultCategoryId={addSubCategoryFor}
      />
      {editCategory && (
        <EditCategoryModal open category={editCategory} onClose={() => setEditCategory(null)} />
      )}
      {editSubCategory && (
        <EditSubCategoryModal
          open
          subCategory={editSubCategory}
          onClose={() => setEditSubCategory(null)}
        />
      )}
    </div>
  );
}
