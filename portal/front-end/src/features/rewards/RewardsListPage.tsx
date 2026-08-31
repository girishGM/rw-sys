/**
 * T-032 — `/rewards`: the Rewards list (03-API-CONTRACT.md §9, 04-FRONTEND.md's
 * "Rewards list / editor | super_admin write | Reward system + connector config + policies").
 *
 * Reached through `router.tsx`'s `RequirePermission entity="reward" action="view"` guard.
 * Same two-control pattern `RulesListPage.tsx`'s own header documents: hiding "Add reward" is
 * UX, the matching `reward:create` permission row is what actually blocks the API either way
 * (TC-19: maker sees a read-only list, no create/edit controls rendered).
 *
 * T-120 — a category → sub-category → status → search filter bar and a Countries-assigned column,
 * matching `RulesListPage.tsx`'s filter bar control-for-control (the task file asks for
 * consistency with it, not a second pattern).
 *
 * **Where each filter runs, and why they differ.** `status` is a real query parameter —
 * `ListRewardsQueryDto` accepts it, so it is sent to the server and filters the whole catalogue.
 * `category`, `sub-category` and `search` are **not** in that DTO (the rewards list endpoint has
 * no equivalent of the rule list's own filters, which T-111 added server-side), and this task owns
 * no back-end file, so they filter the rows already on screen. That difference is visible — a
 * category filter narrows the current page, not every page — so it is stated in the UI rather than
 * left for a user to discover, and filed as its own task for the back end to close.
 *
 * The Countries column reads the existing `reward_country_assignments` endpoint per row
 * (`fetchRewardCountries`, T-032's own, through the same query keys the detail page uses, so the
 * two share one cache) — implementation note 4: a read of what already exists, not new
 * assignment-count plumbing. It renders only for a caller holding `reward_assignment:view`, which
 * is what that endpoint requires; without it the column would be a row of 403s.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import type { RewardListItem } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { PageHeader } from '../../components/PageHeader';
import { Select, type SelectOption } from '../../components/Select';
import { Table, type TableColumn } from '../../components/Table';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { AddRewardModal } from './AddRewardModal';
import { fetchRewardCountries, rewardCountriesQueryKey, useRewardsQuery } from './api';
import type { RewardListParams } from './api';
import { useRewardCategoriesQuery, useRewardSubCategoriesQuery } from './rewardValue';

const ALL_CATEGORIES_OPTION: SelectOption = { value: '', label: 'All categories' };
const ALL_SUB_CATEGORIES_OPTION: SelectOption = { value: '', label: 'All sub-categories' };
const STATUS_OPTIONS: SelectOption[] = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

/** The client-side half of the filter bar — see the file banner for why these three are not
 * query parameters. `search` matches code or name, the same two fields the rules list searches. */
interface ClientFilters {
  readonly categoryId: number | null;
  readonly subCategoryId: number | null;
  readonly search: string;
}

const NO_CLIENT_FILTERS: ClientFilters = { categoryId: null, subCategoryId: null, search: '' };

function matchesClientFilters(row: RewardListItem, filters: ClientFilters): boolean {
  if (filters.categoryId !== null && row.categoryId !== filters.categoryId) return false;
  if (filters.subCategoryId !== null && row.subCategoryId !== filters.subCategoryId) return false;
  if (filters.search !== '') {
    const needle = filters.search.trim().toLowerCase();
    const haystack = `${row.systemCode} ${row.name}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** "2 countries" / "1 country" / "Not assigned" — TC-5. `undefined` while the per-row query is
 * still in flight, so a not-yet-loaded row never reads as an unassigned one. */
function countriesLabel(count: number | undefined): string {
  if (count === undefined) return '…';
  if (count === 0) return 'Not assigned';
  return count === 1 ? '1 country' : `${String(count)} countries`;
}

const BASE_COLUMNS: TableColumn<RewardListItem>[] = [
  { key: 'systemCode', header: 'Code', render: (row) => row.systemCode, sortable: true },
  { key: 'name', header: 'Name', render: (row) => row.name, sortable: true },
  { key: 'category', header: 'Category', render: (row) => row.categoryName },
  { key: 'subCategory', header: 'Sub-category', render: (row) => row.subCategoryName ?? '—' },
  { key: 'rewardType', header: 'Type', render: (row) => row.rewardType },
  { key: 'connectorType', header: 'Connector', render: (row) => row.connectorType },
  {
    key: 'status',
    header: 'Status',
    render: (row) => (
      <Badge tone={row.status === 'active' ? 'success' : 'slate'}>{row.status}</Badge>
    ),
    sortable: true,
  },
];

export function RewardsListPage() {
  const { hasPermission } = useBootstrap();
  const [params, setParams] = useState<RewardListParams>({ page: 1, sort: 'name:asc' });
  const [filters, setFilters] = useState<ClientFilters>(NO_CLIENT_FILTERS);
  const [searchInput, setSearchInput] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading, error } = useRewardsQuery(params);
  const canCreate = hasPermission('reward', 'create');
  const canViewAssignments = hasPermission('reward_assignment', 'view');

  const categoriesQuery = useRewardCategoriesQuery();
  const subCategoriesQuery = useRewardSubCategoriesQuery(filters.categoryId ?? undefined);

  const rows = useMemo(
    () => (data ? data.data.filter((row) => matchesClientFilters(row, filters)) : []),
    [data, filters],
  );

  // One `reward_country_assignments` read per visible row, keyed exactly as the detail page keys
  // it, so opening a reward afterwards is a cache hit rather than a second request.
  const countryQueries = useQueries({
    queries: rows.map((row) => ({
      queryKey: rewardCountriesQueryKey(row.id),
      queryFn: () => fetchRewardCountries(row.id),
      enabled: canViewAssignments,
    })),
  });

  const countsByRowId = useMemo(() => {
    const counts = new Map<number, number>();
    rows.forEach((row, index) => {
      const result = countryQueries[index];
      if (result?.data !== undefined) counts.set(row.id, result.data.length);
    });
    return counts;
  }, [rows, countryQueries]);

  const columns: TableColumn<RewardListItem>[] = useMemo(
    () =>
      canViewAssignments
        ? [
            ...BASE_COLUMNS,
            {
              key: 'countries',
              header: 'Countries',
              render: (row) => countriesLabel(countsByRowId.get(row.id)),
            },
          ]
        : BASE_COLUMNS,
    [canViewAssignments, countsByRowId],
  );

  const categoryOptions: SelectOption[] = useMemo(
    () => [
      ALL_CATEGORIES_OPTION,
      ...(categoriesQuery.data ?? []).map((category) => ({
        value: String(category.id),
        label: category.name,
      })),
    ],
    [categoriesQuery.data],
  );

  const subCategoryOptions: SelectOption[] = useMemo(
    () => [
      ALL_SUB_CATEGORIES_OPTION,
      ...(subCategoriesQuery.data ?? []).map((subCategory) => ({
        value: String(subCategory.id),
        label: subCategory.name,
      })),
    ],
    [subCategoriesQuery.data],
  );

  function handleSortChange(key: string): void {
    setParams((current) => {
      const [currentField, currentDirection] = (current.sort ?? 'name:asc').split(':');
      const direction = currentField === key && currentDirection === 'asc' ? 'desc' : 'asc';
      return { ...current, page: 1, sort: `${key}:${direction}` };
    });
  }

  /** Picking a category always clears the sub-category — the previous choice may not belong to
   * the new category (the same cascade `RulesListPage` uses). */
  function handleCategoryChange(value: string): void {
    setFilters((current) => ({
      ...current,
      categoryId: value === '' ? null : Number(value),
      subCategoryId: null,
    }));
  }

  function handleStatusChange(value: string): void {
    setParams((current) => ({ ...current, page: 1, status: value === '' ? undefined : value }));
  }

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFilters((current) => ({ ...current, search: searchInput }));
  }

  const [sortField, sortDirection] = (params.sort ?? 'name:asc').split(':') as [
    string,
    'asc' | 'desc',
  ];

  const clientFilterActive =
    filters.categoryId !== null || filters.subCategoryId !== null || filters.search !== '';

  return (
    <div className="p-6">
      <PageHeader
        title="Rewards"
        description="Global reward systems, authored once and assigned to the countries that use them."
        actions={
          canCreate && (
            <Button type="button" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Add reward
            </Button>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <Select
          label="Category"
          className="w-56"
          options={categoryOptions}
          value={filters.categoryId === null ? '' : String(filters.categoryId)}
          onChange={handleCategoryChange}
        />
        <Select
          label="Sub-category"
          className="w-56"
          options={subCategoryOptions}
          value={filters.subCategoryId === null ? '' : String(filters.subCategoryId)}
          onChange={(value) =>
            setFilters((current) => ({
              ...current,
              subCategoryId: value === '' ? null : Number(value),
            }))
          }
          disabled={filters.categoryId === null}
        />
        <Select
          label="Status"
          className="w-40"
          options={STATUS_OPTIONS}
          value={params.status ?? ''}
          onChange={handleStatusChange}
        />
        <form onSubmit={handleSearchSubmit} className="flex max-w-sm gap-2">
          <Input
            label="Search"
            hideLabel
            placeholder="Search by code or name"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <Button type="submit" variant="secondary">
            <Search className="size-4" aria-hidden="true" />
            Search
          </Button>
        </form>
      </div>

      {clientFilterActive && (
        <p className="mb-3 text-xs text-slate-500">
          Category, sub-category and search filter the rewards on this page. Status filters the
          whole catalogue.
        </p>
      )}

      <Table
        caption="Rewards"
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        isLoading={isLoading}
        error={error instanceof ApiError ? error.message : null}
        emptyMessage={clientFilterActive ? 'No rewards match these filters' : 'No rewards yet'}
        emptyDescription={
          clientFilterActive
            ? 'Clear a filter, or try another page.'
            : canCreate
              ? 'Add the first reward to get started.'
              : 'No rewards are assigned to you yet.'
        }
        sort={{ key: sortField, direction: sortDirection }}
        onSortChange={handleSortChange}
        onRowClick={(row) => navigate(`/rewards/${String(row.id)}`)}
      />

      {data && data.meta.total > data.meta.pageSize && (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
          <span>
            Page {data.meta.page} of {Math.ceil(data.meta.total / data.meta.pageSize)}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={data.meta.page <= 1}
              onClick={() => setParams((current) => ({ ...current, page: data.meta.page - 1 }))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={data.meta.page * data.meta.pageSize >= data.meta.total}
              onClick={() => setParams((current) => ({ ...current, page: data.meta.page + 1 }))}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <AddRewardModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
