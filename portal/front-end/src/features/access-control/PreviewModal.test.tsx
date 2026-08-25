import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { PreviewResponse } from '@reward-portal/shared';

const { mockUsePreviewMutation, mockMutate } = vi.hoisted(() => ({
  mockUsePreviewMutation: vi.fn(),
  mockMutate: vi.fn(),
}));

vi.mock('./api', () => ({ usePreviewMutation: mockUsePreviewMutation }));

import { PreviewModal } from './PreviewModal';

const previewResponse: PreviewResponse = {
  role: 'merchant',
  nav: [{ key: 'dashboard', label: 'Dashboard', icon: null, path: '/dashboard', children: [] }],
  permissions: { campaign: ['view'] },
  widgets: [{ key: 'kpi_active_campaigns', label: 'Active Campaigns', config: {} }],
};

beforeEach(() => {
  mockUsePreviewMutation.mockReset();
  mockMutate.mockReset();
});

describe('PreviewModal — TC-17, verification step 7', () => {
  it('requests a preview for the given role when opened', () => {
    mockUsePreviewMutation.mockReturnValue({
      mutate: mockMutate,
      isPending: true,
      data: undefined,
    });
    render(<PreviewModal open role="merchant" onClose={vi.fn()} />);
    expect(mockMutate).toHaveBeenCalledWith({ role: 'merchant' });
  });

  it('does not request anything while closed', () => {
    mockUsePreviewMutation.mockReturnValue({
      mutate: mockMutate,
      isPending: false,
      data: undefined,
    });
    render(<PreviewModal open={false} role="merchant" onClose={vi.fn()} />);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('renders the returned nav, permissions and widgets, with a not-persisted notice', async () => {
    mockUsePreviewMutation.mockReturnValue({
      mutate: mockMutate,
      isPending: false,
      data: previewResponse,
    });
    render(<PreviewModal open role="merchant" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });
    expect(screen.getByText(/campaign: view/)).toBeInTheDocument();
    expect(screen.getByText('Active Campaigns')).toBeInTheDocument();
    expect(screen.getByText(/nothing shown here has been saved/i)).toBeInTheDocument();
  });

  it('shows an error state when the preview request fails', () => {
    mockUsePreviewMutation.mockReturnValue({
      mutate: mockMutate,
      isPending: false,
      isError: true,
      data: undefined,
    });
    render(<PreviewModal open role="merchant" onClose={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not load the preview/i);
  });
});
