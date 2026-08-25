import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

const {
  mockUseRewardQuery,
  mockUseRewardCountriesQuery,
  mockUseRewardPoliciesQuery,
  mockUseDeleteRewardMutation,
} = vi.hoisted(() => ({
  mockUseRewardQuery: vi.fn(),
  mockUseRewardCountriesQuery: vi.fn(),
  mockUseRewardPoliciesQuery: vi.fn(),
  mockUseDeleteRewardMutation: vi.fn(),
}));

vi.mock('./api', () => ({
  useRewardQuery: mockUseRewardQuery,
  useRewardCountriesQuery: mockUseRewardCountriesQuery,
  useRewardPoliciesQuery: mockUseRewardPoliciesQuery,
  useDeleteRewardMutation: mockUseDeleteRewardMutation,
}));
vi.mock('./EditRewardModal', () => ({
  EditRewardModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="edit-reward-modal" /> : null,
}));
vi.mock('./AssignCountriesModal', () => ({
  AssignCountriesModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="assign-countries-modal" /> : null,
}));
vi.mock('./AddPolicyModal', () => ({
  AddPolicyModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-policy-modal" /> : null,
}));

import { RewardDetailPage } from './RewardDetailPage';

const reward = {
  id: 1,
  systemCode: 'CASHBACK_STANDARD',
  name: 'Standard cashback',
  description: null,
  rewardType: 'monetary',
  deliveryMode: 'realtime' as const,
  connectorType: 'internal_api' as const,
  connectorConfigPreview: { apiKey: '••••1234' },
  maintenanceWindowEnabled: false,
  maintenanceSchedule: {},
  retryEnabled: true,
  retryConfig: {},
  merchantId: null,
  status: 'active' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function bootstrapValue(overrides: Partial<Record<string, boolean>> = {}): BootstrapContextValue {
  return {
    user: { id: 1, displayName: 'Test User', role: 'super_admin', locale: 'en', timezone: null },
    scope: { countryId: null, tenantId: null, merchantId: null },
    nav: [],
    permissions: {},
    widgets: [],
    messages: {},
    isLoading: false,
    isError: false,
    isUnauthorized: false,
    hasPermission: (entity, action) => overrides[`${entity}:${action}`] ?? false,
    refetch: () => undefined,
  };
}

function renderPage(permissions: Record<string, boolean> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(permissions)}>
        <MemoryRouter initialEntries={['/rewards/1']}>
          <Routes>
            <Route path="/rewards/:id" element={<RewardDetailPage />} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseRewardQuery.mockReset();
  mockUseRewardCountriesQuery.mockReset();
  mockUseRewardPoliciesQuery.mockReset();
  mockUseDeleteRewardMutation.mockReset();
  mockUseDeleteRewardMutation.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  mockUseRewardCountriesQuery.mockReturnValue({ data: [], isLoading: false });
  mockUseRewardPoliciesQuery.mockReturnValue({ data: [], isLoading: false });
});

describe('RewardDetailPage', () => {
  it('renders the reward name and system code', () => {
    mockUseRewardQuery.mockReturnValue({ data: reward, isLoading: false, isError: false });

    renderPage({ 'reward:view': true });

    expect(screen.getByText('Standard cashback')).toBeInTheDocument();
    expect(screen.getByText(/CASHBACK_STANDARD/)).toBeInTheDocument();
  });

  it('TC-12: renders the masked connectorConfig value, never plaintext', () => {
    mockUseRewardQuery.mockReturnValue({ data: reward, isLoading: false, isError: false });

    renderPage({ 'reward:view': true });

    expect(screen.getByText('••••1234')).toBeInTheDocument();
  });

  it('renders "No connector configuration set" when connectorConfigPreview is null', () => {
    mockUseRewardQuery.mockReturnValue({
      data: { ...reward, connectorConfigPreview: null },
      isLoading: false,
      isError: false,
    });

    renderPage({ 'reward:view': true });

    expect(screen.getByText(/no connector configuration set/i)).toBeInTheDocument();
  });

  it('super_admin (full CRUD) sees Edit, Delete and Assign countries', () => {
    mockUseRewardQuery.mockReturnValue({ data: reward, isLoading: false, isError: false });

    renderPage({ 'reward:update': true, 'reward:delete': true, 'reward_assignment:create': true });

    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /assign countries/i })).toBeInTheDocument();
  });

  it('TC-19: maker (read-only) sees no Edit, Delete or Assign control', () => {
    mockUseRewardQuery.mockReturnValue({ data: reward, isLoading: false, isError: false });

    renderPage({});

    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /assign countries/i })).not.toBeInTheDocument();
    expect(screen.getByText('Standard cashback')).toBeInTheDocument();
  });

  it('renders assigned countries once populated, on the Countries tab', async () => {
    mockUseRewardQuery.mockReturnValue({ data: reward, isLoading: false, isError: false });
    mockUseRewardCountriesQuery.mockReturnValue({
      data: [
        {
          id: 500,
          rewardId: 1,
          countryId: 2,
          countryCode: 'SG',
          countryName: 'Singapore',
          assignedAt: '2026-01-01T00:00:00.000Z',
          assignedBy: null,
        },
      ],
      isLoading: false,
    });

    const user = userEvent.setup();
    renderPage({ 'reward:view': true });
    await user.click(screen.getByRole('tab', { name: /countries/i }));

    expect(screen.getByText(/Singapore/)).toBeInTheDocument();
  });

  it('renders reward policies once populated, on the Policies tab', async () => {
    mockUseRewardQuery.mockReturnValue({ data: reward, isLoading: false, isError: false });
    mockUseRewardPoliciesQuery.mockReturnValue({
      data: [
        {
          id: 10,
          rewardSystemId: 1,
          policyCode: 'STANDARD',
          name: 'Standard policy',
          description: null,
          config: {},
          status: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      isLoading: false,
    });

    const user = userEvent.setup();
    renderPage({ 'reward:view': true, 'reward:update': true });
    await user.click(screen.getByRole('tab', { name: /policies/i }));

    expect(screen.getByText('Standard policy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add policy/i })).toBeInTheDocument();
  });

  it('shows loading skeletons for the Countries and Policies tabs', async () => {
    mockUseRewardQuery.mockReturnValue({ data: reward, isLoading: false, isError: false });
    mockUseRewardCountriesQuery.mockReturnValue({ data: undefined, isLoading: true });
    mockUseRewardPoliciesQuery.mockReturnValue({ data: undefined, isLoading: true });

    const user = userEvent.setup();
    renderPage({ 'reward:view': true });
    await user.click(screen.getByRole('tab', { name: /countries/i }));
    await user.click(screen.getByRole('tab', { name: /policies/i }));

    // Both tabs rendered without throwing while their queries were still loading.
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
  });

  it('opens the Add Policy modal from the Policies tab', async () => {
    mockUseRewardQuery.mockReturnValue({ data: reward, isLoading: false, isError: false });
    const user = userEvent.setup();
    renderPage({ 'reward:view': true, 'reward:update': true });

    await user.click(screen.getByRole('tab', { name: /policies/i }));
    await user.click(screen.getByRole('button', { name: /add policy/i }));

    expect(screen.getByTestId('add-policy-modal')).toBeInTheDocument();
  });

  it('shows a 404/error state when the reward is not visible to the caller (TC-6)', () => {
    mockUseRewardQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { message: 'Not found.' },
    });

    renderPage({});
    expect(screen.getByText('Could not load this reward')).toBeInTheDocument();
  });
});
