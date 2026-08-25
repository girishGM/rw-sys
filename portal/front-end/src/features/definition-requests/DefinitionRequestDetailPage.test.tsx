import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Bootstrap, DefinitionRequest } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

const {
  mockUseDefinitionRequestQuery,
  mockUseWithdrawDefinitionRequestMutation,
  mockUseReviewDefinitionRequestMutation,
  mockUseFulfilDefinitionRequestMutation,
  mockWithdraw,
  mockReview,
  mockFulfil,
} = vi.hoisted(() => ({
  mockUseDefinitionRequestQuery: vi.fn(),
  mockUseWithdrawDefinitionRequestMutation: vi.fn(),
  mockUseReviewDefinitionRequestMutation: vi.fn(),
  mockUseFulfilDefinitionRequestMutation: vi.fn(),
  mockWithdraw: vi.fn(),
  mockReview: vi.fn(),
  mockFulfil: vi.fn(),
}));

vi.mock('./api', () => ({
  useDefinitionRequestQuery: mockUseDefinitionRequestQuery,
  useWithdrawDefinitionRequestMutation: mockUseWithdrawDefinitionRequestMutation,
  useReviewDefinitionRequestMutation: mockUseReviewDefinitionRequestMutation,
  useFulfilDefinitionRequestMutation: mockUseFulfilDefinitionRequestMutation,
}));
vi.mock('./EditDefinitionRequestModal', () => ({
  EditDefinitionRequestModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="edit-request-modal" /> : null,
}));

import { DefinitionRequestDetailPage } from './DefinitionRequestDetailPage';

function requestRow(overrides: Partial<DefinitionRequest> = {}): DefinitionRequest {
  return {
    id: 1,
    requestType: 'new_rule',
    entityId: null,
    requestedBy: 1,
    requestingCountryId: 9,
    requestingTenantId: null,
    title: 'Weekend multiplier',
    description: 'We need a weekend multiplier rule.',
    businessJustification: null,
    desiredBy: null,
    priority: 'normal',
    status: 'submitted',
    reviewedBy: null,
    reviewedAt: null,
    reviewComment: null,
    fulfilledVersionId: null,
    fulfilledAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function bootstrapValue(role: Bootstrap['user']['role']): BootstrapContextValue {
  const grants: Record<string, string[]> = {
    super_admin: ['view', 'review', 'fulfil'],
    country_admin: ['view', 'create', 'update', 'withdraw'],
    tenant_admin: ['view', 'create', 'update', 'withdraw'],
  };
  return {
    user: { id: 1, displayName: 'Test User', role, locale: 'en', timezone: null },
    scope: { countryId: 9, tenantId: null, merchantId: null },
    nav: [],
    permissions: {},
    widgets: [],
    messages: {},
    isLoading: false,
    isError: false,
    isUnauthorized: false,
    hasPermission: (entity, action) =>
      entity === 'definition_request' && (grants[role] ?? []).includes(action),
    refetch: () => undefined,
  };
}

function renderPage(role: Bootstrap['user']['role']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(role)}>
        <MemoryRouter initialEntries={['/definition-requests/1']}>
          <Routes>
            <Route path="/definition-requests/:id" element={<DefinitionRequestDetailPage />} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseDefinitionRequestQuery.mockReset();
  mockUseWithdrawDefinitionRequestMutation.mockReset();
  mockUseReviewDefinitionRequestMutation.mockReset();
  mockUseFulfilDefinitionRequestMutation.mockReset();
  mockWithdraw.mockReset();
  mockReview.mockReset();
  mockFulfil.mockReset();
  mockUseWithdrawDefinitionRequestMutation.mockReturnValue({
    mutateAsync: mockWithdraw,
    isPending: false,
  });
  mockUseReviewDefinitionRequestMutation.mockReturnValue({
    mutateAsync: mockReview,
    isPending: false,
  });
  mockUseFulfilDefinitionRequestMutation.mockReturnValue({
    mutateAsync: mockFulfil,
    isPending: false,
  });
});

describe('DefinitionRequestDetailPage', () => {
  it('renders the request title and description', () => {
    mockUseDefinitionRequestQuery.mockReturnValue({
      data: requestRow(),
      isLoading: false,
      error: null,
    });
    renderPage('super_admin');
    expect(screen.getByText('Weekend multiplier')).toBeInTheDocument();
    expect(screen.getByText('We need a weekend multiplier rule.')).toBeInTheDocument();
  });

  it('TC-6: a requester sees Edit/Withdraw while submitted', () => {
    mockUseDefinitionRequestQuery.mockReturnValue({
      data: requestRow({ status: 'submitted' }),
      isLoading: false,
      error: null,
    });
    renderPage('country_admin');
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^withdraw$/i })).toBeInTheDocument();
  });

  it('TC-7: a requester does not see Edit/Withdraw once under_review', () => {
    mockUseDefinitionRequestQuery.mockReturnValue({
      data: requestRow({ status: 'under_review' }),
      isLoading: false,
      error: null,
    });
    renderPage('country_admin');
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^withdraw$/i })).not.toBeInTheDocument();
  });

  it('TC-9: super_admin sees "Start review" while submitted', async () => {
    mockUseDefinitionRequestQuery.mockReturnValue({
      data: requestRow({ status: 'submitted' }),
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();
    renderPage('super_admin');

    await user.click(screen.getByRole('button', { name: /start review/i }));
    expect(mockReview).toHaveBeenCalledWith({ status: 'under_review' });
  });

  it('TC-10/TC-11: rejecting requires a comment before the Confirm button is enabled', async () => {
    mockUseDefinitionRequestQuery.mockReturnValue({
      data: requestRow({ status: 'under_review' }),
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();
    renderPage('super_admin');

    await user.click(screen.getByRole('button', { name: /^reject$/i }));
    const confirmButton = screen.getByRole('button', { name: /confirm rejection/i });
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByLabelText(/reason for rejection/i), 'Not enough detail');
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);
    expect(mockReview).toHaveBeenCalledWith({
      status: 'rejected',
      reviewComment: 'Not enough detail',
    });
  });

  it('TC-13: super_admin fulfils an approved request with a version id', async () => {
    mockUseDefinitionRequestQuery.mockReturnValue({
      data: requestRow({ status: 'approved' }),
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();
    renderPage('super_admin');

    await user.type(screen.getByLabelText(/published version id/i), '10');
    await user.click(screen.getByRole('button', { name: /^fulfil$/i }));

    expect(mockFulfil).toHaveBeenCalledWith({ versionId: 10 });
  });

  it('TC-8: a requester withdraws via the confirm dialog', async () => {
    mockUseDefinitionRequestQuery.mockReturnValue({
      data: requestRow({ status: 'submitted' }),
      isLoading: false,
      error: null,
    });
    const user = userEvent.setup();
    renderPage('country_admin');

    await user.click(screen.getByRole('button', { name: /^withdraw$/i }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^withdraw$/i }));

    expect(mockWithdraw).toHaveBeenCalled();
  });

  it('shows an error message when the request fails to load', () => {
    mockUseDefinitionRequestQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
    });
    renderPage('super_admin');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
