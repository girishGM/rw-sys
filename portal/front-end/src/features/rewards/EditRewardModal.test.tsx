import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Reward } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

const {
  mockMutateAsync,
  mockUseUpdateRewardMutation,
  mockUseVersionsQuery,
  mockUpdateDraft,
  mockCreateRewardVersionDraft,
  mockUseTenantCurrenciesQuery,
  mockUseTenantsQuery,
} = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseUpdateRewardMutation: vi.fn(),
  mockUseVersionsQuery: vi.fn(),
  mockUpdateDraft: vi.fn(),
  mockCreateRewardVersionDraft: vi.fn(),
  mockUseTenantCurrenciesQuery: vi.fn(),
  mockUseTenantsQuery: vi.fn(),
}));

vi.mock('./api', () => ({ useUpdateRewardMutation: mockUseUpdateRewardMutation }));
vi.mock('../versions/api', () => ({
  useVersionsQuery: mockUseVersionsQuery,
  updateDraft: mockUpdateDraft,
}));
vi.mock('../tenants/api', () => ({ useTenantsQuery: mockUseTenantsQuery }));
vi.mock('./rewardValue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rewardValue')>()),
  useTenantCurrenciesQuery: mockUseTenantCurrenciesQuery,
  createRewardVersionDraft: mockCreateRewardVersionDraft,
}));

import { EditRewardModal } from './EditRewardModal';
import { ApiError } from '../../lib/apiError';

const reward: Reward = {
  id: 1,
  systemCode: 'CASHBACK_STANDARD',
  name: 'Standard cashback',
  description: null,
  rewardType: 'monetary',
  deliveryMode: 'realtime',
  connectorType: 'internal_api',
  connectorConfigPreview: { apiKey: '••••1234' },
  maintenanceWindowEnabled: false,
  maintenanceSchedule: {},
  retryEnabled: true,
  retryConfig: {},
  merchantId: null,
  categoryId: 7,
  categoryName: 'Cashback',
  subCategoryId: 21,
  subCategoryName: 'Instant',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** A `reward_versions` row as `GET /rewards/:id/versions` returns it — only the keys this modal
 * actually reads are filled in. */
function rewardVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: 900,
    rewardId: 1,
    versionNo: 1,
    status: 'draft',
    rewardKind: null,
    valueConfig: null,
    ...overrides,
  };
}

function bootstrapValue(): BootstrapContextValue {
  return {
    user: { id: 1, displayName: 'Test User', role: 'super_admin', locale: 'en', timezone: null },
    scope: { countryId: null, tenantId: 3, merchantId: null },
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

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue()}>
        <EditRewardModal open onClose={onClose} reward={reward} />
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseUpdateRewardMutation.mockReset();
  mockUseVersionsQuery.mockReset();
  mockUpdateDraft.mockReset();
  mockCreateRewardVersionDraft.mockReset();
  mockUseTenantCurrenciesQuery.mockReset();
  mockUseTenantsQuery.mockReset();

  mockUseUpdateRewardMutation.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
  mockMutateAsync.mockResolvedValue(reward);
  mockUseVersionsQuery.mockReturnValue({ data: [rewardVersion()], isLoading: false });
  mockUpdateDraft.mockResolvedValue(rewardVersion());
  mockCreateRewardVersionDraft.mockResolvedValue(rewardVersion());
  mockUseTenantCurrenciesQuery.mockReturnValue({
    data: [
      {
        id: 1,
        tenantId: 3,
        currencyCode: 'MYR',
        isDefault: true,
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    isLoading: false,
  });
  mockUseTenantsQuery.mockReturnValue({
    data: { data: [], meta: { page: 1, pageSize: 100, total: 0 } },
    isLoading: false,
  });
});

describe('EditRewardModal', () => {
  it('does not render systemCode as an editable field — immutable (matches UpdateRewardDto)', () => {
    renderModal();
    expect(screen.queryByLabelText(/system code/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Edit CASHBACK_STANDARD/)).toBeInTheDocument();
  });

  it('never pre-fills connectorConfig — the server never returns the plaintext (implementation note 4)', () => {
    renderModal();
    expect(screen.queryByDisplayValue('••••1234')).not.toBeInTheDocument();
    expect(screen.getByText(/no connector configuration set/i)).toBeInTheDocument();
  });

  it('TC-7: submits a name change, omitting connectorConfig entirely', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    const nameInput = screen.getByLabelText(/^name$/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'New name');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New name', status: 'active' }),
    );
    const call = mockMutateAsync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call['connectorConfig']).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });

  it('TC-22: submits a status change to inactive', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('combobox', { name: /status/i }));
    await user.click(screen.getByRole('option', { name: 'Inactive' }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ status: 'inactive' }));
  });

  it('shows the server error message when the update fails', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({ code: 'PERM_DENIED', message: 'You may not do this.', status: 403 }),
    );
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('You may not do this.');
  });

  it('TC-7/TC-13: replacing connectorConfig sends the new plaintext value (encrypted server-side)', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: /add field/i }));
    await user.type(screen.getByPlaceholderText('apiKey'), 'apiKey');
    await user.type(screen.getByPlaceholderText(/sk_live/i), 'sk_live_5678');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ connectorConfig: { apiKey: 'sk_live_5678' } }),
    );
  });

  it('shows category and sub-category read-only — T-118 made them immutable-by-replacement', () => {
    renderModal();

    expect(screen.getByText('Cashback')).toBeInTheDocument();
    expect(screen.getByText('Instant')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /^category$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /sub-category/i })).not.toBeInTheDocument();
  });

  it('opens on the Kind already stored on the draft version, rather than on a blank editor', () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [rewardVersion({ rewardKind: 'POINTS', valueConfig: { points: 250 } })],
      isLoading: false,
    });
    renderModal();

    expect(screen.getByRole('combobox', { name: /^kind$/i })).toHaveTextContent('Points');
    expect(screen.getByRole('textbox', { name: /^points$/i })).toHaveValue('250');
  });

  it('PATCHes the Kind onto the existing draft version, never onto the reward row', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('combobox', { name: /^kind$/i }));
    await user.click(screen.getByRole('option', { name: 'Points' }));
    await user.type(screen.getByRole('textbox', { name: /^points$/i }), '100');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockUpdateDraft).toHaveBeenCalledWith('reward', 1, 900, {
      rewardKind: 'POINTS',
      valueConfig: { points: 100 },
    });
    const rewardPatch = mockMutateAsync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(rewardPatch['rewardKind']).toBeUndefined();
    expect(rewardPatch['valueConfig']).toBeUndefined();
    expect(mockCreateRewardVersionDraft).not.toHaveBeenCalled();
  });

  it('creates a draft version when the reward has none — a published version is never written to', async () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [rewardVersion({ id: 800, status: 'published', rewardKind: 'POINTS' })],
      isLoading: false,
    });
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('combobox', { name: /^kind$/i }));
    await user.click(screen.getByRole('option', { name: 'Percentage' }));
    await user.type(screen.getByRole('textbox', { name: /^percentage$/i }), '5');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockCreateRewardVersionDraft).toHaveBeenCalledWith(1, {
      rewardKind: 'PERCENTAGE',
      valueConfig: { percentage: 5 },
    });
    expect(mockUpdateDraft).not.toHaveBeenCalled();
  });

  it('writes no version at all when the Kind is left unset — it does not clear what is stored', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockMutateAsync).toHaveBeenCalled();
    expect(mockUpdateDraft).not.toHaveBeenCalled();
    expect(mockCreateRewardVersionDraft).not.toHaveBeenCalled();
  });

  it('blocks an invalid value client-side before either request fires', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('combobox', { name: /^kind$/i }));
    await user.click(screen.getByRole('option', { name: 'Percentage' }));
    await user.type(screen.getByRole('textbox', { name: /^percentage$/i }), '150');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(mockUpdateDraft).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(/percentage/i);
  });
});
