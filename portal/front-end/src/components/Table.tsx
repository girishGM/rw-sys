import { type Key, type ReactNode } from 'react';
import { AlertCircle, ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cx } from './internal/cx';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';

export interface TableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sortable?: boolean;
  className?: string;
}

export type SortDirection = 'asc' | 'desc';

export interface TableProps<T> {
  columns: TableColumn<T>[];
  data: T[];
  getRowId: (row: T) => Key;
  isLoading?: boolean;
  /** Non-null puts the table into the error state, taking precedence over `data`. */
  error?: string | null;
  emptyMessage?: string;
  emptyDescription?: string;
  sort?: { key: string; direction: SortDirection };
  onSortChange?: (key: string) => void;
  skeletonRowCount?: number;
  onRowClick?: (row: T) => void;
  caption: string;
}

/**
 * T-021 — one component, four states (loading / error / empty / populated), so feature
 * agents never re-implement any of them (implementation note 3). TC-5..TC-7.
 */
export function Table<T>({
  columns,
  data,
  getRowId,
  isLoading = false,
  error = null,
  emptyMessage = 'No results found',
  emptyDescription,
  sort,
  onSortChange,
  skeletonRowCount = 5,
  onRowClick,
  caption,
}: TableProps<T>) {
  return (
    <div className="overflow-x-auto rounded-card border border-slate-200">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            {columns.map((column) => {
              const isSorted = sort?.key === column.key;
              const ariaSort = !column.sortable
                ? undefined
                : isSorted
                  ? sort!.direction === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none';
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={ariaSort}
                  className={cx(
                    'px-4 py-2.5 text-left font-medium text-slate-600',
                    column.className,
                  )}
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      onClick={() => onSortChange?.(column.key)}
                      className={cx(
                        'inline-flex items-center gap-1 hover:text-slate-900',
                        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
                      )}
                    >
                      {column.header}
                      {isSorted ? (
                        sort!.direction === 'asc' ? (
                          <ArrowUp className="size-3.5" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="size-3.5" aria-hidden="true" />
                        )
                      ) : (
                        <ChevronsUpDown className="size-3.5 text-slate-300" aria-hidden="true" />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <tr>
              <td colSpan={columns.length} className="p-0">
                <div
                  role="status"
                  aria-label="Loading table data"
                  className="divide-y divide-slate-100"
                >
                  {Array.from({ length: skeletonRowCount }).map((_, rowIndex) => (
                    <div key={rowIndex} className="flex items-center gap-4 px-4 py-3">
                      {columns.map((column) => (
                        <Skeleton key={column.key} className="h-4 flex-1" />
                      ))}
                    </div>
                  ))}
                </div>
              </td>
            </tr>
          ) : error ? (
            <tr>
              <td colSpan={columns.length}>
                <div
                  role="alert"
                  className="flex flex-col items-center gap-2 px-6 py-12 text-center"
                >
                  <AlertCircle className="size-10 text-danger-400" aria-hidden="true" />
                  <p className="text-sm font-medium text-danger-700">{error}</p>
                </div>
              </td>
            </tr>
          ) : data.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>
                <EmptyState message={emptyMessage} description={emptyDescription} />
              </td>
            </tr>
          ) : (
            data.map((row) => (
              <tr
                key={getRowId(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cx(
                  'border-b border-slate-100 last:border-b-0',
                  onRowClick && 'cursor-pointer hover:bg-slate-50',
                )}
              >
                {columns.map((column) => (
                  <td key={column.key} className={cx('px-4 py-3 text-slate-700', column.className)}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
