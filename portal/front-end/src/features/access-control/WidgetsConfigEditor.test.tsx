import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WidgetConfigResponse } from '@reward-portal/shared';
import { ApiError } from '../../lib/apiError';

const {
  mockUseWidgetsQuery,
  mockUsePutWidgetsMutation,
  mockUseReorderWidgetsMutation,
  mockPutMutate,
  mockReorderMutate,
} = vi.hoisted(() => ({
  mockUseWidgetsQuery: vi.fn(),
  mockUsePutWidgetsMutation: vi.fn(),
  mockUseReorderWidgetsMutation: vi.fn(),
  mockPutMutate: vi.fn(),
  mockReorderMutate: vi.fn(),
}));

vi.mock('./api', () => ({
  useWidgetsQuery: mockUseWidgetsQuery,
  usePutWidgetsMutation: mockUsePutWidgetsMutation,
  useReorderWidgetsMutation: mockUseReorderWidgetsMutation,
}));

import { WidgetsConfigEditor } from './WidgetsConfigEditor';

const makerWidgets: WidgetConfigResponse = {
  role: 'maker',
  version: 2,
  items: [
    { widgetKey: 'kpi_my_drafts', label: 'My Drafts', config: {}, sortOrder: 10, enabled: true },
    { widgetKey: 'kpi_my_pending', label: 'My Pending', config: {}, sortOrder: 20, enabled: true },
  ],
};

beforeEach(() => {
  mockUseWidgetsQuery.mockReset();
  mockUsePutWidgetsMutation.mockReset();
  mockUseReorderWidgetsMutation.mockReset();
  mockPutMutate.mockReset();
  mockReorderMutate.mockReset();
  mockUsePutWidgetsMutation.mockReturnValue({
    mutate: mockPutMutate,
    isPending: false,
    error: null,
  });
  mockUseReorderWidgetsMutation.mockReturnValue({ mutate: mockReorderMutate, isPending: false });
});

describe('WidgetsConfigEditor', () => {
  it('renders every widget for the role', () => {
    mockUseWidgetsQuery.mockReturnValue({ data: makerWidgets, isLoading: false });
    render(<WidgetsConfigEditor role="maker" />);
    expect(screen.getByDisplayValue('My Drafts')).toBeInTheDocument();
    expect(screen.getByDisplayValue('My Pending')).toBeInTheDocument();
  });

  it('disabling a widget toggle marks the draft dirty', async () => {
    mockUseWidgetsQuery.mockReturnValue({ data: makerWidgets, isLoading: false });
    const user = userEvent.setup();
    render(<WidgetsConfigEditor role="maker" />);

    expect(screen.getByRole('button', { name: 'Save dashboard' })).toBeDisabled();
    await user.click(screen.getByRole('switch', { name: 'Enabled: My Drafts' }));
    expect(screen.getByRole('button', { name: 'Save dashboard' })).not.toBeDisabled();
  });

  it('Save submits expectedVersion and the current items', async () => {
    mockUseWidgetsQuery.mockReturnValue({ data: makerWidgets, isLoading: false });
    const user = userEvent.setup();
    render(<WidgetsConfigEditor role="maker" />);

    await user.click(screen.getByRole('switch', { name: 'Enabled: My Drafts' }));
    await user.click(screen.getByRole('button', { name: 'Save dashboard' }));

    expect(mockPutMutate).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 2 }));
  });

  it('reordering issues a single bulk call', async () => {
    mockUseWidgetsQuery.mockReturnValue({ data: makerWidgets, isLoading: false });
    const user = userEvent.setup();
    render(<WidgetsConfigEditor role="maker" />);

    await user.click(screen.getByRole('button', { name: 'Move My Pending up' }));

    expect(mockReorderMutate).toHaveBeenCalledTimes(1);
    expect(mockReorderMutate).toHaveBeenCalledWith({
      expectedVersion: 2,
      order: [
        { key: 'kpi_my_pending', sortOrder: 10 },
        { key: 'kpi_my_drafts', sortOrder: 20 },
      ],
    });
  });

  it('shows a conflict message on a 409, and Reload latest refetches', async () => {
    const refetch = vi.fn();
    mockUseWidgetsQuery.mockReturnValue({ data: makerWidgets, isLoading: false, refetch });
    mockUsePutWidgetsMutation.mockReturnValue({
      mutate: mockPutMutate,
      isPending: false,
      error: new ApiError({
        code: 'ACCESS_CONTROL_VERSION_CONFLICT',
        message: 'Stale.',
        status: 409,
      }),
    });
    const user = userEvent.setup();
    render(<WidgetsConfigEditor role="maker" />);
    expect(screen.getByRole('alert')).toHaveTextContent('changed elsewhere');
    await user.click(screen.getByRole('button', { name: 'Reload latest' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('renders a loading skeleton while the query is pending', () => {
    mockUseWidgetsQuery.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = render(<WidgetsConfigEditor role="maker" />);
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it('removing a widget marks the draft dirty', async () => {
    mockUseWidgetsQuery.mockReturnValue({ data: makerWidgets, isLoading: false });
    const user = userEvent.setup();
    render(<WidgetsConfigEditor role="maker" />);

    await user.click(screen.getByRole('button', { name: 'Remove My Drafts' }));
    expect(screen.getByRole('button', { name: 'Save dashboard' })).not.toBeDisabled();
  });
});
