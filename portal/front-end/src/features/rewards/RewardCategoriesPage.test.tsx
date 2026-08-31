/**
 * T-117 — unit tests for the Rewards Categories page. See `features/rules/CategoriesPage.test.tsx`'s
 * own header for why this stays thin: `CategoryManager` (`features/shared/CategoryManager.tsx`)
 * carries its own exhaustive suite, run for both `kind: 'rule'` and `kind: 'reward'`. This file
 * only proves `RewardCategoriesPage` wires it up with `kind="reward"` and the right page chrome.
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

import { RewardCategoriesPage } from './RewardCategoriesPage';

describe('RewardCategoriesPage', () => {
  it('renders the page header and the shared CategoryManager with kind="reward"', () => {
    render(<RewardCategoriesPage />);

    expect(screen.getByRole('heading', { name: 'Categories' })).toBeInTheDocument();
    expect(screen.getByTestId('category-manager')).toHaveAttribute('data-kind', 'reward');
    expect(mockCategoryManager).toHaveBeenCalledWith({ kind: 'reward' });
  });
});
