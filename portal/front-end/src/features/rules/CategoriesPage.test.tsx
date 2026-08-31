/**
 * T-107 / T-117 — unit tests for the Rules Categories page. `CategoryManager` itself (the
 * two-pane manager, list rendering, permission gating, inline add/retire flows) has its own
 * exhaustive suite (`features/shared/CategoryManager.test.tsx`, run for both `kind: 'rule'` and
 * `kind: 'reward'`) — this file only proves `CategoriesPage` wires that shared component up
 * correctly for the Rules side: the right `kind`, and the page chrome (`PageHeader`) around it.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CategoryManagerProps } from '../shared/CategoryManager';

const { mockCategoryManager } = vi.hoisted(() => ({ mockCategoryManager: vi.fn() }));

vi.mock('../shared/CategoryManager', () => ({
  CategoryManager: (props: CategoryManagerProps) => {
    mockCategoryManager(props);
    return <div data-testid="category-manager" data-kind={props.kind} />;
  },
}));

import { CategoriesPage } from './CategoriesPage';

describe('CategoriesPage', () => {
  it('renders the page header and the shared CategoryManager with kind="rule"', () => {
    render(<CategoriesPage />);

    expect(screen.getByRole('heading', { name: 'Categories' })).toBeInTheDocument();
    expect(screen.getByTestId('category-manager')).toHaveAttribute('data-kind', 'rule');
    expect(mockCategoryManager).toHaveBeenCalledWith({ kind: 'rule' });
  });
});
