/**
 * T-117 — the two-pane category/sub-category manager (`super-admin-rules-rewards-theme-preview.html`),
 * replacing T-107's flat table + four modals (`AddCategoryModal`/`EditCategoryModal`/
 * `AddSubCategoryModal`/`EditSubCategoryModal`) for Rules, and standing in as the very first
 * screen for Rewards' brand-new categories (T-116 built the CRUD endpoints, nothing consumed
 * them until this component).
 *
 * One component, driven entirely by `kind`, so Rules and Rewards categories can never drift
 * apart again the way T-107's Rules-only build and T-116's un-consumed Rewards endpoints
 * already had started to: `kind` selects the API base path (`/rule-categories` vs
 * `/reward-categories`), the `role_entity_permissions` entity pair (`rule_category`/
 * `rule_sub_category` vs `reward_category`/`reward_sub_category`), and the empty-state copy
 * (only Rewards gets the "a category can have zero sub-categories" hint — Points is this
 * screen's own worked example).
 *
 * **No delete affordance.** T-106/T-116 never built `DELETE /rule-categories` or
 * `DELETE /reward-categories` — both retire a row via `PATCH .../status`. There is also, today,
 * no server-side check blocking that retire when the category/sub-category is still referenced
 * by a rule/reward master (`rules.service.ts#updateCategory` / `rewards.service.ts
 * #updateCategory` both apply the status change unconditionally). This component therefore never
 * invents a client-side "in use" guard of its own (AGENT-PROTOCOL.md §3: "delete... client-side
 * is not required — trust the backend's own referential constraint / 409") — it always attempts
 * the retire and surfaces whatever the backend returns as a toast, so the day a referential guard
 * is added server-side (a real gap, flagged in this task's completion report) this component
 * needs no change at all to honour it.
 */
import { useState, type FormEvent } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createRewardCategoryRequestSchema,
  createRewardSubCategoryRequestSchema,
  createRuleCategoryRequestSchema,
  createRuleSubCategoryRequestSchema,
  rewardCategoryEnvelopeSchema,
  rewardCategoryListEnvelopeSchema,
  rewardSubCategoryEnvelopeSchema,
  rewardSubCategoryListEnvelopeSchema,
  ruleCategoryEnvelopeSchema,
  ruleCategoryListEnvelopeSchema,
  ruleSubCategoryEnvelopeSchema,
  ruleSubCategoryListEnvelopeSchema,
  updateRewardCategoryRequestSchema,
  updateRewardSubCategoryRequestSchema,
  updateRuleCategoryRequestSchema,
  updateRuleSubCategoryRequestSchema,
} from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Skeleton } from '../../components/Skeleton';
import { toast } from '../../components/toastActions';
import { useBootstrap } from '../../auth/useBootstrap';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

export type CategoryManagerKind = 'rule' | 'reward';

/** The shape both `RuleCategory` and `RewardCategory` (`@reward-portal/shared`) already share
 * field-for-field — declared locally so this component never has to pick one over the other. */
export interface CategoryManagerCategory {
  readonly id: number;
  readonly categoryCode: string;
  readonly name: string;
  readonly status: string;
}

/** See {@link CategoryManagerCategory} — same reasoning for `RuleSubCategory`/`RewardSubCategory`. */
export interface CategoryManagerSubCategory {
  readonly id: number;
  readonly categoryId: number;
  readonly subCategoryCode: string;
  readonly name: string;
  readonly status: string;
}

type Status = 'active' | 'inactive';

export interface CategoryManagerProps {
  readonly kind: CategoryManagerKind;
}

function categoriesPath(kind: CategoryManagerKind): string {
  return kind === 'rule' ? '/rule-categories' : '/reward-categories';
}

function subCategoriesPath(kind: CategoryManagerKind): string {
  return kind === 'rule' ? '/rule-sub-categories' : '/reward-sub-categories';
}

/** Matches `useRuleCategoriesQuery`'s own key (`features/rules/api.ts`) for `kind: 'rule'`, so a
 * category created here is picked up — with no page reload — by `AddRuleModal`'s cascading
 * picker, which shares the same TanStack Query cache. */
function categoriesQueryKey(kind: CategoryManagerKind): readonly [string] {
  return [`${kind}-categories`];
}

/** Matches `useRuleSubCategoriesQuery()`'s own key (called with no `categoryId`) for the same
 * cross-cache-invalidation reason as {@link categoriesQueryKey}. */
function subCategoriesQueryKey(kind: CategoryManagerKind): readonly [string, null] {
  return [`${kind}-sub-categories`, null];
}

function categoryEntity(kind: CategoryManagerKind): string {
  return kind === 'rule' ? 'rule_category' : 'reward_category';
}

function subCategoryEntity(kind: CategoryManagerKind): string {
  return kind === 'rule' ? 'rule_sub_category' : 'reward_sub_category';
}

async function fetchCategories(
  kind: CategoryManagerKind,
): Promise<readonly CategoryManagerCategory[]> {
  try {
    const response = await api.get<unknown>(categoriesPath(kind));
    if (kind === 'rule') {
      const parsed = ruleCategoryListEnvelopeSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error(
          `Categories response did not match the expected shape: ${parsed.error.message}`,
        );
      }
      return parsed.data.data;
    }
    const parsed = rewardCategoryListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Categories response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

async function fetchSubCategories(
  kind: CategoryManagerKind,
): Promise<readonly CategoryManagerSubCategory[]> {
  try {
    const response = await api.get<unknown>(subCategoriesPath(kind));
    if (kind === 'rule') {
      const parsed = ruleSubCategoryListEnvelopeSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error(
          `Sub-categories response did not match the expected shape: ${parsed.error.message}`,
        );
      }
      return parsed.data.data;
    }
    const parsed = rewardSubCategoryListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Sub-categories response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

async function createCategory(
  kind: CategoryManagerKind,
  input: { categoryCode: string; name: string },
): Promise<CategoryManagerCategory> {
  try {
    if (kind === 'rule') {
      const payload = createRuleCategoryRequestSchema.parse(input);
      const response = await api.post<unknown>(categoriesPath(kind), payload);
      const parsed = ruleCategoryEnvelopeSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error(
          `Create-category response did not match the expected shape: ${parsed.error.message}`,
        );
      }
      return parsed.data.data;
    }
    const payload = createRewardCategoryRequestSchema.parse(input);
    const response = await api.post<unknown>(categoriesPath(kind), payload);
    const parsed = rewardCategoryEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-category response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

async function updateCategoryStatus(
  kind: CategoryManagerKind,
  id: number,
  status: Status,
): Promise<CategoryManagerCategory> {
  try {
    if (kind === 'rule') {
      const payload = updateRuleCategoryRequestSchema.parse({ status });
      const response = await api.patch<unknown>(`${categoriesPath(kind)}/${String(id)}`, payload);
      const parsed = ruleCategoryEnvelopeSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error(
          `Update-category response did not match the expected shape: ${parsed.error.message}`,
        );
      }
      return parsed.data.data;
    }
    const payload = updateRewardCategoryRequestSchema.parse({ status });
    const response = await api.patch<unknown>(`${categoriesPath(kind)}/${String(id)}`, payload);
    const parsed = rewardCategoryEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Update-category response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

async function createSubCategory(
  kind: CategoryManagerKind,
  input: { categoryId: number; subCategoryCode: string; name: string },
): Promise<CategoryManagerSubCategory> {
  try {
    if (kind === 'rule') {
      const payload = createRuleSubCategoryRequestSchema.parse(input);
      const response = await api.post<unknown>(subCategoriesPath(kind), payload);
      const parsed = ruleSubCategoryEnvelopeSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error(
          `Create-sub-category response did not match the expected shape: ${parsed.error.message}`,
        );
      }
      return parsed.data.data;
    }
    const payload = createRewardSubCategoryRequestSchema.parse(input);
    const response = await api.post<unknown>(subCategoriesPath(kind), payload);
    const parsed = rewardSubCategoryEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-sub-category response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

async function updateSubCategoryStatus(
  kind: CategoryManagerKind,
  id: number,
  status: Status,
): Promise<CategoryManagerSubCategory> {
  try {
    if (kind === 'rule') {
      const payload = updateRuleSubCategoryRequestSchema.parse({ status });
      const response = await api.patch<unknown>(
        `${subCategoriesPath(kind)}/${String(id)}`,
        payload,
      );
      const parsed = ruleSubCategoryEnvelopeSchema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error(
          `Update-sub-category response did not match the expected shape: ${parsed.error.message}`,
        );
      }
      return parsed.data.data;
    }
    const payload = updateRewardSubCategoryRequestSchema.parse({ status });
    const response = await api.patch<unknown>(`${subCategoriesPath(kind)}/${String(id)}`, payload);
    const parsed = rewardSubCategoryEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Update-sub-category response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

interface CategoryFieldErrors {
  categoryCode?: string;
  name?: string;
}

interface SubCategoryFieldErrors {
  subCategoryCode?: string;
  name?: string;
}

export function CategoryManager({ kind }: CategoryManagerProps) {
  const { hasPermission } = useBootstrap();
  // T-106/T-116 seed identical grants for both entities of a given kind (`super_admin`:
  // view/create/update; every other role: view only), so in practice these always agree —
  // checked separately anyway rather than collapsing to one flag (T-107's own
  // `CategoriesPage.tsx` precedent), so a future role-config change that grants only one of
  // the two is reflected here immediately instead of silently over- or under-gating.
  const canWriteCategory = hasPermission(categoryEntity(kind), 'create');
  const canWriteSubCategory = hasPermission(subCategoryEntity(kind), 'create');

  const queryClient = useQueryClient();
  const categoriesQuery = useQuery({
    queryKey: categoriesQueryKey(kind),
    queryFn: () => fetchCategories(kind),
  });
  const subCategoriesQuery = useQuery({
    queryKey: subCategoriesQueryKey(kind),
    queryFn: () => fetchSubCategories(kind),
  });

  const createCategoryMutation = useMutation({
    mutationFn: (input: { categoryCode: string; name: string }) => createCategory(kind, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: categoriesQueryKey(kind) });
    },
  });
  const updateCategoryStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: Status }) =>
      updateCategoryStatus(kind, id, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: categoriesQueryKey(kind) });
    },
  });
  const createSubCategoryMutation = useMutation({
    mutationFn: (input: { categoryId: number; subCategoryCode: string; name: string }) =>
      createSubCategory(kind, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: subCategoriesQueryKey(kind) });
    },
  });
  const updateSubCategoryStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: Status }) =>
      updateSubCategoryStatus(kind, id, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: subCategoriesQueryKey(kind) });
    },
  });

  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [newCategoryCode, setNewCategoryCode] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [categoryFieldErrors, setCategoryFieldErrors] = useState<CategoryFieldErrors>({});
  const [newSubCategoryCode, setNewSubCategoryCode] = useState('');
  const [newSubCategoryName, setNewSubCategoryName] = useState('');
  const [subCategoryFieldErrors, setSubCategoryFieldErrors] = useState<SubCategoryFieldErrors>({});

  const categories = categoriesQuery.data ?? [];
  const subCategories = subCategoriesQuery.data ?? [];
  const isLoading = categoriesQuery.isLoading || subCategoriesQuery.isLoading;

  // TC-1: "first category selected by default" — falls straight out of this derivation, no
  // effect needed: nothing is explicitly selected yet, so the first category wins; once the
  // actor clicks a different one, `selectedCategoryId` takes over.
  const selectedCategory =
    categories.find((category) => category.id === selectedCategoryId) ?? categories[0] ?? null;
  const selectedSubCategories = selectedCategory
    ? subCategories.filter((sub) => sub.categoryId === selectedCategory.id)
    : [];

  async function handleAddCategory(event: FormEvent): Promise<void> {
    event.preventDefault();
    setCategoryFieldErrors({});

    const input = { categoryCode: newCategoryCode.trim(), name: newCategoryName.trim() };
    // Branched per `kind` rather than picked into one `schema` variable — a union of the two
    // (structurally near-identical, but distinct) Zod object types resolves `.safeParse`'s own
    // generics to `any`, which then makes every field read off its `ZodIssue[]` untyped too.
    const parsed =
      kind === 'rule'
        ? createRuleCategoryRequestSchema.safeParse(input)
        : createRewardCategoryRequestSchema.safeParse(input);
    if (!parsed.success) {
      const errors: CategoryFieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'categoryCode' || field === 'name') errors[field] = issue.message;
      }
      setCategoryFieldErrors(errors);
      return;
    }

    try {
      const created = await createCategoryMutation.mutateAsync(parsed.data);
      setSelectedCategoryId(created.id);
      setNewCategoryCode('');
      setNewCategoryName('');
      toast.success(`Category ${created.categoryCode} created`);
    } catch (error) {
      toast.error(toApiError(error).message);
    }
  }

  async function handleAddSubCategory(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSubCategoryFieldErrors({});
    if (!selectedCategory) return;

    const input = {
      categoryId: selectedCategory.id,
      subCategoryCode: newSubCategoryCode.trim(),
      name: newSubCategoryName.trim(),
    };
    const parsed =
      kind === 'rule'
        ? createRuleSubCategoryRequestSchema.safeParse(input)
        : createRewardSubCategoryRequestSchema.safeParse(input);
    if (!parsed.success) {
      const errors: SubCategoryFieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'subCategoryCode' || field === 'name') errors[field] = issue.message;
      }
      setSubCategoryFieldErrors(errors);
      return;
    }

    try {
      const created = await createSubCategoryMutation.mutateAsync(parsed.data);
      setNewSubCategoryCode('');
      setNewSubCategoryName('');
      toast.success(`Sub-category ${created.subCategoryCode} created`);
    } catch (error) {
      toast.error(toApiError(error).message);
    }
  }

  async function handleToggleCategoryStatus(category: CategoryManagerCategory): Promise<void> {
    const nextStatus: Status = category.status === 'active' ? 'inactive' : 'active';
    try {
      await updateCategoryStatusMutation.mutateAsync({ id: category.id, status: nextStatus });
      toast.success(
        nextStatus === 'inactive'
          ? `${category.categoryCode} retired`
          : `${category.categoryCode} reactivated`,
      );
    } catch (error) {
      // T-106/T-116 never built a referential-integrity check on this endpoint (see this
      // file's own header) — today this always succeeds. Surfacing whatever the server
      // returns as a toast, rather than a hard-coded "can't remove — in use" string, is what
      // makes this component correct on the day that check is added without needing a change
      // here at all.
      toast.error(toApiError(error).message);
    }
  }

  async function handleToggleSubCategoryStatus(
    subCategory: CategoryManagerSubCategory,
  ): Promise<void> {
    const nextStatus: Status = subCategory.status === 'active' ? 'inactive' : 'active';
    try {
      await updateSubCategoryStatusMutation.mutateAsync({
        id: subCategory.id,
        status: nextStatus,
      });
      toast.success(
        nextStatus === 'inactive'
          ? `${subCategory.subCategoryCode} retired`
          : `${subCategory.subCategoryCode} reactivated`,
      );
    } catch (error) {
      toast.error(toApiError(error).message);
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[280px_1fr]">
      <div data-testid="category-list" className="flex flex-col gap-2">
        {categories.map((category) => {
          const count = subCategories.filter((sub) => sub.categoryId === category.id).length;
          const isActive = selectedCategory?.id === category.id;
          return (
            <button
              key={category.id}
              type="button"
              onClick={() => setSelectedCategoryId(category.id)}
              aria-current={isActive || undefined}
              className={`flex items-center justify-between gap-2 rounded-card border px-3 py-2.5 text-left ${
                isActive
                  ? 'border-primary-500 bg-primary-50'
                  : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-slate-800">
                  {category.name}
                </span>
                <code className="block truncate text-xs text-slate-400">
                  {category.categoryCode}
                </code>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {category.status !== 'active' && <Badge tone="slate">inactive</Badge>}
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                  {count}
                </span>
              </span>
            </button>
          );
        })}

        {categories.length === 0 && (
          <p className="rounded-card border border-dashed border-slate-300 p-4 text-center text-sm text-slate-400">
            No categories yet{canWriteCategory ? ' — add one below.' : '.'}
          </p>
        )}

        {canWriteCategory && (
          <form
            onSubmit={(event) => void handleAddCategory(event)}
            className="flex flex-col gap-2 pt-2"
          >
            <Input
              label="Category code"
              hideLabel
              placeholder="CODE"
              value={newCategoryCode}
              onChange={(event) => setNewCategoryCode(event.target.value)}
              error={categoryFieldErrors.categoryCode}
            />
            <Input
              label="Category name"
              hideLabel
              placeholder="Name"
              value={newCategoryName}
              onChange={(event) => setNewCategoryName(event.target.value)}
              error={categoryFieldErrors.name}
            />
            <Button type="submit" size="sm" isLoading={createCategoryMutation.isPending}>
              + Add category
            </Button>
          </form>
        )}
      </div>

      <div
        data-testid="category-detail"
        className="rounded-card border border-slate-200 bg-white shadow-sm"
      >
        {!selectedCategory ? (
          <div className="p-6">
            <p className="text-sm text-slate-400">No categories yet — add one on the left.</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-semibold text-slate-800">{selectedCategory.name}</h3>
                <code className="text-xs text-slate-400">{selectedCategory.categoryCode}</code>
                <Badge tone={selectedCategory.status === 'active' ? 'success' : 'slate'}>
                  {selectedCategory.status}
                </Badge>
              </div>
              {canWriteCategory && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleToggleCategoryStatus(selectedCategory)}
                  aria-label={
                    selectedCategory.status === 'active'
                      ? `Retire ${selectedCategory.categoryCode}`
                      : `Reactivate ${selectedCategory.categoryCode}`
                  }
                >
                  {selectedCategory.status === 'active' ? (
                    <Trash2 className="size-4" aria-hidden="true" />
                  ) : (
                    <RotateCcw className="size-4" aria-hidden="true" />
                  )}
                  {selectedCategory.status === 'active' ? 'Retire' : 'Reactivate'}
                </Button>
              )}
            </div>

            <div className="flex flex-col gap-2 px-4 py-3">
              {selectedSubCategories.length === 0 ? (
                <p className="rounded-card border border-dashed border-slate-300 p-4 text-center text-sm text-slate-400">
                  No sub-categories under {selectedCategory.categoryCode} yet
                  {kind === 'reward' ? ' — that may be fine for a category like Points.' : '.'}
                </p>
              ) : (
                selectedSubCategories.map((sub) => (
                  <div
                    key={sub.id}
                    className="flex items-center justify-between gap-3 rounded-card bg-slate-50 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-700">
                        {sub.name}
                      </span>
                      <code className="block truncate text-xs text-slate-400">
                        {sub.subCategoryCode}
                      </code>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge tone={sub.status === 'active' ? 'success' : 'slate'}>
                        {sub.status}
                      </Badge>
                      {canWriteSubCategory && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleToggleSubCategoryStatus(sub)}
                          aria-label={
                            sub.status === 'active'
                              ? `Retire ${sub.subCategoryCode}`
                              : `Reactivate ${sub.subCategoryCode}`
                          }
                        >
                          {sub.status === 'active' ? (
                            <Trash2 className="size-4" aria-hidden="true" />
                          ) : (
                            <RotateCcw className="size-4" aria-hidden="true" />
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                ))
              )}

              {canWriteSubCategory && (
                <form
                  onSubmit={(event) => void handleAddSubCategory(event)}
                  className="mt-2 flex flex-col gap-2 border-t border-dashed border-slate-200 pt-3 sm:flex-row sm:items-start"
                >
                  <Input
                    label="Sub-category code"
                    hideLabel
                    placeholder="SUB_CODE"
                    value={newSubCategoryCode}
                    onChange={(event) => setNewSubCategoryCode(event.target.value)}
                    error={subCategoryFieldErrors.subCategoryCode}
                    containerClassName="flex-1"
                  />
                  <Input
                    label="Sub-category name"
                    hideLabel
                    placeholder="Sub-category name"
                    value={newSubCategoryName}
                    onChange={(event) => setNewSubCategoryName(event.target.value)}
                    error={subCategoryFieldErrors.name}
                    containerClassName="flex-1"
                  />
                  <Button type="submit" size="sm" isLoading={createSubCategoryMutation.isPending}>
                    + Add sub-category
                  </Button>
                </form>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
