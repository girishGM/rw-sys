import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

const {
  mockUseMerchantQuery,
  mockUseStoresQuery,
  mockUseActivitiesQuery,
  mockUseActiveCampaignsQuery,
  mockUseUpdateMerchantMutation,
  mockUpdate,
} = vi.hoisted(() => ({
  mockUseMerchantQuery: vi.fn(),
  mockUseStoresQuery: vi.fn(),
  mockUseActivitiesQuery: vi.fn(),
  mockUseActiveCampaignsQuery: vi.fn(),
  mockUseUpdateMerchantMutation: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('./api', () => ({
  useMerchantQuery: mockUseMerchantQuery,
  useStoresQuery: mockUseStoresQuery,
  useActivitiesQuery: mockUseActivitiesQuery,
  useActiveCampaignsQuery: mockUseActiveCampaignsQuery,
  useUpdateMerchantMutation: mockUseUpdateMerchantMutation,
}));
vi.mock('./AddMerchantStoreModal', () => ({
  AddMerchantStoreModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-store-modal" /> : null,
}));
vi.mock('./AddMerchantActivityModal', () => ({
  AddMerchantActivityModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-activity-modal" /> : null,
}));

import { MerchantDetailPage } from './MerchantDetailPage';

const merchant = {
  id: 100,
  tenantId: 10,
  merchantCode: 'M001',
  name: 'Acme Store',
  description: 'A great merchant',
  contactEmail: 'ops@acme.example',
  contactPhone: null,
  website: null,
  countryCode: 'MY',
  status: 'active' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function bootstrapValue(): BootstrapContextValue {
  return {
    user: { id: 1, displayName: 'Test User', role: 'tenant_admin', locale: 'en', timezone: null },
    scope: { countryId: 1, tenantId: 10, merchantId: null },
    nav: [],
    permissions: {},
    widgets: [],
    messages: {},
    isLoading: false,
    isError: false,
    isUnauthorized: false,
    hasPermission: () => true,
    refetch: () => undefined,
  };
}

function renderPage(initialPath = '/merchants/100') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue()}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/merchants/:id" element={<MerchantDetailPage />} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseMerchantQuery.mockReset();
  mockUseStoresQuery.mockReset();
  mockUseActivitiesQuery.mockReset();
  mockUseActiveCampaignsQuery.mockReset();
  mockUseUpdateMerchantMutation.mockReset();
  mockUpdate.mockReset();
  mockUseStoresQuery.mockReturnValue({ data: [], isLoading: false });
  mockUseActivitiesQuery.mockReturnValue({ data: [], isLoading: false });
  mockUseActiveCampaignsQuery.mockReturnValue({ data: [], isLoading: false });
  mockUseUpdateMerchantMutation.mockReturnValue({ mutate: mockUpdate, isPending: false });
});

describe('MerchantDetailPage', () => {
  it('renders the merchant name, code and details', () => {
    mockUseMerchantQuery.mockReturnValue({ data: merchant, isLoading: false, isError: false });

    renderPage();

    expect(screen.getByRole('heading', { name: 'Acme Store' })).toBeInTheDocument();
    expect(screen.getByText(/M001/)).toBeInTheDocument();
    expect(screen.getByText('A great merchant')).toBeInTheDocument();
    expect(screen.getByText('ops@acme.example')).toBeInTheDocument();
  });

  it('renders a "—" placeholder for null optional fields', () => {
    mockUseMerchantQuery.mockReturnValue({
      data: {
        ...merchant,
        description: null,
        contactEmail: null,
        contactPhone: null,
        website: null,
      },
      isLoading: false,
      isError: false,
    });

    renderPage();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
  });

  it('offers Deactivate for an active merchant with no active campaigns — deactivates immediately, no confirm dialog', async () => {
    mockUseMerchantQuery.mockReturnValue({ data: merchant, isLoading: false, isError: false });
    mockUseActiveCampaignsQuery.mockReturnValue({ data: [], isLoading: false });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByRole('button', { name: /deactivate/i }));

    expect(mockUpdate).toHaveBeenCalledWith({ status: 'inactive' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('deactivating a merchant with active campaigns requires explicit confirmation (TC-20)', async () => {
    mockUseMerchantQuery.mockReturnValue({ data: merchant, isLoading: false, isError: false });
    mockUseActiveCampaignsQuery.mockReturnValue({
      data: [{ id: 900, campaignCode: 'C900', name: 'Summer Promo', status: 'active' }],
      isLoading: false,
    });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByRole('button', { name: /deactivate/i }));

    // The consequence is surfaced, not applied silently — no mutation yet.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/Summer Promo/)).toBeInTheDocument();
    expect(screen.getByText(/sessions? .* will be revoked/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /deactivate anyway/i }));
    expect(mockUpdate).toHaveBeenCalledWith(
      { status: 'inactive', confirm: true },
      expect.objectContaining({ onSuccess: expect.any(Function) as unknown }),
    );
  });

  it('offers Activate for an inactive merchant', async () => {
    mockUseMerchantQuery.mockReturnValue({
      data: { ...merchant, status: 'inactive' },
      isLoading: false,
      isError: false,
    });
    const user = userEvent.setup();

    renderPage();
    expect(screen.queryByRole('button', { name: /deactivate/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^activate$/i }));
    expect(mockUpdate).toHaveBeenCalledWith({ status: 'active' });
  });

  it('shows the Stores tab with existing stores and offers Add store', async () => {
    mockUseMerchantQuery.mockReturnValue({ data: merchant, isLoading: false, isError: false });
    mockUseStoresQuery.mockReturnValue({
      data: [
        {
          id: 200,
          tenantId: 10,
          merchantId: 100,
          storeCode: 'S001',
          name: 'Main Store',
          address: null,
          city: null,
          state: null,
          postalCode: null,
          region: null,
          latitude: null,
          longitude: null,
          status: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      isLoading: false,
    });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByRole('tab', { name: /stores/i }));

    expect(screen.getByText(/Main Store/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add store/i }));
    expect(screen.getByTestId('add-store-modal')).toBeInTheDocument();
  });

  it('shows an inactive store badge tone', async () => {
    mockUseMerchantQuery.mockReturnValue({ data: merchant, isLoading: false, isError: false });
    mockUseStoresQuery.mockReturnValue({
      data: [
        {
          id: 200,
          tenantId: 10,
          merchantId: 100,
          storeCode: 'S001',
          name: 'Closed Store',
          address: null,
          city: null,
          state: null,
          postalCode: null,
          region: null,
          latitude: null,
          longitude: null,
          status: 'inactive',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      isLoading: false,
    });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByRole('tab', { name: /stores/i }));

    expect(screen.getByText(/Closed Store/)).toBeInTheDocument();
  });

  it('shows the empty and loading states for the Stores tab', async () => {
    mockUseMerchantQuery.mockReturnValue({ data: merchant, isLoading: false, isError: false });
    mockUseStoresQuery.mockReturnValue({ data: [], isLoading: false });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByRole('tab', { name: /stores/i }));
    expect(screen.getByText('No stores yet')).toBeInTheDocument();
  });

  it('shows a loading skeleton for the Stores tab', async () => {
    mockUseMerchantQuery.mockReturnValue({ data: merchant, isLoading: false, isError: false });
    mockUseStoresQuery.mockReturnValue({ data: undefined, isLoading: true });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByRole('tab', { name: /stores/i }));
    expect(screen.queryByText('No stores yet')).not.toBeInTheDocument();
  });

  it('shows the Activities tab with existing links and offers Link activity', async () => {
    mockUseMerchantQuery.mockReturnValue({ data: merchant, isLoading: false, isError: false });
    mockUseActivitiesQuery.mockReturnValue({
      data: [
        {
          id: 300,
          tenantId: 10,
          merchantId: 100,
          activityId: 50,
          storeId: null,
          commissionRate: '12.34',
          status: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      isLoading: false,
    });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByRole('tab', { name: /activities/i }));

    expect(screen.getByText(/Activity #50/)).toBeInTheDocument();
    expect(screen.getByText(/tenant-wide/)).toBeInTheDocument();
    expect(screen.getByText(/12.34%/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /link activity/i }));
    expect(screen.getByTestId('add-activity-modal')).toBeInTheDocument();
  });

  it('renders a store-scoped activity link and a null commission rate', async () => {
    mockUseMerchantQuery.mockReturnValue({ data: merchant, isLoading: false, isError: false });
    mockUseActivitiesQuery.mockReturnValue({
      data: [
        {
          id: 301,
          tenantId: 10,
          merchantId: 100,
          activityId: 60,
          storeId: 200,
          commissionRate: null,
          status: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      isLoading: false,
    });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByRole('tab', { name: /activities/i }));

    expect(screen.getByText(/Activity #60/)).toBeInTheDocument();
    expect(screen.getByText(/store #200/)).toBeInTheDocument();
  });

  it('shows the empty and loading states for the Activities tab', async () => {
    mockUseMerchantQuery.mockReturnValue({ data: merchant, isLoading: false, isError: false });
    mockUseActivitiesQuery.mockReturnValue({ data: [], isLoading: false });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByRole('tab', { name: /activities/i }));
    expect(screen.getByText('No activities linked yet')).toBeInTheDocument();
  });

  it('shows a loading skeleton for the Activities tab', async () => {
    mockUseMerchantQuery.mockReturnValue({ data: merchant, isLoading: false, isError: false });
    mockUseActivitiesQuery.mockReturnValue({ data: undefined, isLoading: true });
    const user = userEvent.setup();

    renderPage();
    await user.click(screen.getByRole('tab', { name: /activities/i }));
    expect(screen.queryByText('No activities linked yet')).not.toBeInTheDocument();
  });

  it('shows loading skeletons while the merchant is loading', () => {
    mockUseMerchantQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false });

    renderPage();

    expect(screen.queryByRole('heading', { name: 'Acme Store' })).not.toBeInTheDocument();
  });

  it('shows an error state when the merchant cannot be loaded', () => {
    mockUseMerchantQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: null,
    });

    renderPage();

    expect(screen.getByText('Could not load this merchant', { exact: true })).toBeInTheDocument();
  });

  it('shows the server error message when it is an ApiError instance', async () => {
    const { ApiError } = await import('../../lib/apiError');
    mockUseMerchantQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError({ code: 'NOT_FOUND', message: 'No such merchant.', status: 404 }),
    });

    renderPage();

    expect(screen.getByText('No such merchant.')).toBeInTheDocument();
  });

  it('shows an invalid-id message for a non-numeric route param', () => {
    mockUseMerchantQuery.mockReturnValue({ data: undefined, isLoading: false, isError: false });
    renderPage('/merchants/not-a-number');
    expect(screen.getByText('Invalid merchant id')).toBeInTheDocument();
  });
});
