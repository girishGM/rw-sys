import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

const {
  mockMutateAsync,
  mockUseCreateRewardMutation,
  mockCreateRewardVersionDraft,
  mockUseRewardCategoriesQuery,
  mockUseRewardSubCategoriesQuery,
  mockUseTenantCurrenciesQuery,
  mockUseTenantsQuery,
} = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseCreateRewardMutation: vi.fn(),
  mockCreateRewardVersionDraft: vi.fn(),
  mockUseRewardCategoriesQuery: vi.fn(),
  mockUseRewardSubCategoriesQuery: vi.fn(),
  mockUseTenantCurrenciesQuery: vi.fn(),
  mockUseTenantsQuery: vi.fn(),
}));

vi.mock('./api', () => ({ useCreateRewardMutation: mockUseCreateRewardMutation }));
vi.mock('../tenants/api', () => ({ useTenantsQuery: mockUseTenantsQuery }));

// Only the network-touching exports are stubbed — `buildValueConfig` and the draft helpers stay
// real, because they are what turns this form's text boxes into the payload under test.
vi.mock('./rewardValue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rewardValue')>()),
  useRewardCategoriesQuery: mockUseRewardCategoriesQuery,
  useRewardSubCategoriesQuery: mockUseRewardSubCategoriesQuery,
  useTenantCurrenciesQuery: mockUseTenantCurrenciesQuery,
  createRewardVersionDraft: mockCreateRewardVersionDraft,
}));

import { AddRewardModal } from './AddRewardModal';
import { ApiError } from '../../lib/apiError';

const CATEGORIES = [
  { id: 7, categoryCode: 'CASHBACK', name: 'Cashback', status: 'active' },
  { id: 8, categoryCode: 'POINTS', name: 'Points', status: 'active' },
];
const SUB_CATEGORIES = [
  { id: 21, categoryId: 7, subCategoryCode: 'INSTANT', name: 'Instant', status: 'active' },
];

function currency(code: string, isDefault = false) {
  return {
    id: code.charCodeAt(0),
    tenantId: 3,
    currencyCode: code,
    isDefault,
    status: 'active' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const createdReward = {
  id: 1,
  systemCode: 'CASHBACK_STANDARD',
  name: 'Standard cashback',
  description: null,
  rewardType: 'monetary',
  deliveryMode: 'realtime',
  connectorType: 'internal_api',
  connectorConfig: null,
  maintenanceWindowEnabled: false,
  maintenanceSchedule: {},
  retryEnabled: true,
  retryConfig: {},
  merchantId: null,
  categoryId: 7,
  categoryName: 'Cashback',
  subCategoryId: null,
  subCategoryName: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** `super_admin` — no tenant of their own, which is why the Fixed Amount editor asks which
 * tenant's currency list to author against (`scope.tenantId === null`). */
function bootstrapValue(tenantId: number | null): BootstrapContextValue {
  return {
    user: { id: 1, displayName: 'Test User', role: 'super_admin', locale: 'en', timezone: null },
    scope: { countryId: null, tenantId, merchantId: null },
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

function renderModal(onClose = vi.fn(), tenantId: number | null = 3) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(tenantId)}>
        <AddRewardModal open onClose={onClose} />
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

/** Everything `POST /rewards` needs, minus whatever the individual test is exercising. */
async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/system code/i), 'CASHBACK_STANDARD');
  await user.type(screen.getByLabelText(/^name$/i), 'Standard cashback');
  await user.type(screen.getByLabelText(/reward type/i), 'monetary');
  await user.click(screen.getByRole('combobox', { name: /connector type/i }));
  await user.click(screen.getByRole('option', { name: 'internal_api' }));
  await user.click(screen.getByRole('combobox', { name: /^category$/i }));
  await user.click(screen.getByRole('option', { name: 'Cashback' }));
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseCreateRewardMutation.mockReset();
  mockCreateRewardVersionDraft.mockReset();
  mockUseRewardCategoriesQuery.mockReset();
  mockUseRewardSubCategoriesQuery.mockReset();
  mockUseTenantCurrenciesQuery.mockReset();
  mockUseTenantsQuery.mockReset();

  mockUseCreateRewardMutation.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
  mockMutateAsync.mockResolvedValue(createdReward);
  mockCreateRewardVersionDraft.mockResolvedValue({ id: 900, rewardId: 1, versionNo: 1 });
  mockUseRewardCategoriesQuery.mockReturnValue({ data: CATEGORIES, isLoading: false });
  mockUseRewardSubCategoriesQuery.mockReturnValue({ data: SUB_CATEGORIES, isLoading: false });
  mockUseTenantCurrenciesQuery.mockReturnValue({
    data: [currency('MYR', true), currency('SGD')],
    isLoading: false,
  });
  mockUseTenantsQuery.mockReturnValue({
    data: {
      data: [{ id: 3, code: 'ACME', name: 'Acme' }],
      meta: { page: 1, pageSize: 100, total: 1 },
    },
    isLoading: false,
  });
});

describe('AddRewardModal', () => {
  it('rejects a too-short system code before calling the API — the shared Zod schema catches it client-side', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/system code/i), 'X');
    await user.type(screen.getByLabelText(/^name$/i), 'Standard cashback');
    await user.type(screen.getByLabelText(/reward type/i), 'monetary');
    await user.click(screen.getByRole('combobox', { name: /connector type/i }));
    await user.click(screen.getByRole('option', { name: 'internal_api' }));
    await user.click(screen.getByRole('combobox', { name: /^category$/i }));
    await user.click(screen.getByRole('option', { name: 'Cashback' }));
    await user.click(screen.getByRole('button', { name: /create reward/i }));

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('shows the server error message when creation fails', async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError({ code: 'REWARD_SYSTEM_CODE_EXISTS', message: 'Already exists.', status: 409 }),
    );
    const user = userEvent.setup();
    renderModal();

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create reward/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Already exists.');
  });

  it('TC-7: submits a valid reward with no connector config — T-032 behaviour, unchanged', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create reward/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        systemCode: 'CASHBACK_STANDARD',
        name: 'Standard cashback',
        rewardType: 'monetary',
        connectorType: 'internal_api',
        categoryId: 7,
      }),
    );
    const call = mockMutateAsync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call['connectorConfig']).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });

  it('TC-7: adds a connectorConfig field through the embedded editor and includes it on submit (implementation note 4)', async () => {
    const user = userEvent.setup();
    renderModal();

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /add field/i }));
    await user.type(screen.getByPlaceholderText('apiKey'), 'apiKey');
    await user.type(screen.getByPlaceholderText(/sk_live/i), 'sk_live_1234');

    await user.click(screen.getByRole('button', { name: /create reward/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ connectorConfig: { apiKey: 'sk_live_1234' } }),
    );
  });

  it('TC-9: blocks submit client-side when no category is picked — the request never fires', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText(/system code/i), 'CASHBACK_STANDARD');
    await user.type(screen.getByLabelText(/^name$/i), 'Standard cashback');
    await user.type(screen.getByLabelText(/reward type/i), 'monetary');
    await user.click(screen.getByRole('combobox', { name: /connector type/i }));
    await user.click(screen.getByRole('option', { name: 'internal_api' }));

    await user.click(screen.getByRole('button', { name: /create reward/i }));

    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(await screen.findByText('Pick a category.')).toBeInTheDocument();
  });

  it('sends the chosen sub-category, and clears it when the category changes', async () => {
    const user = userEvent.setup();
    renderModal();

    await fillRequiredFields(user);
    await user.click(screen.getByRole('combobox', { name: /sub-category/i }));
    await user.click(screen.getByRole('option', { name: 'Instant' }));

    // Re-picking the category must drop the now-possibly-foreign sub-category.
    await user.click(screen.getByRole('combobox', { name: /^category$/i }));
    await user.click(screen.getByRole('option', { name: 'Points' }));

    await user.click(screen.getByRole('button', { name: /create reward/i }));

    const call = mockMutateAsync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call['categoryId']).toBe(8);
    expect(call['subCategoryId']).toBeUndefined();
  });

  it('TC-1: creates a FIXED_AMOUNT reward with multi-currency off, then authors the Kind on a draft version', async () => {
    const user = userEvent.setup();
    renderModal();

    await fillRequiredFields(user);
    await user.click(screen.getByRole('combobox', { name: /^kind$/i }));
    await user.click(screen.getByRole('option', { name: 'Fixed amount' }));
    await user.click(screen.getByRole('combobox', { name: /^currency$/i }));
    await user.click(screen.getByRole('option', { name: 'MYR' }));
    await user.type(screen.getByLabelText(/^amount$/i), '25');

    await user.click(screen.getByRole('button', { name: /create reward/i }));

    // The connector half of the request is untouched by the Kind half (TC-7).
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ connectorType: 'internal_api', categoryId: 7 }),
    );
    expect(mockCreateRewardVersionDraft).toHaveBeenCalledWith(1, {
      rewardKind: 'FIXED_AMOUNT',
      valueConfig: { multiCurrency: false, defaultCurrency: 'MYR', defaultValue: 25 },
    });
  });

  it('TC-2: multi-currency on sends one entry per currency filled in, from the tenant list', async () => {
    const user = userEvent.setup();
    renderModal();

    await fillRequiredFields(user);
    await user.click(screen.getByRole('combobox', { name: /^kind$/i }));
    await user.click(screen.getByRole('option', { name: 'Fixed amount' }));
    await user.click(screen.getByRole('switch', { name: /one amount per currency/i }));

    await user.type(screen.getByLabelText(/amount in MYR/i), '25');
    await user.type(screen.getByLabelText(/amount in SGD/i), '8.5');

    await user.click(screen.getByRole('button', { name: /create reward/i }));

    expect(mockCreateRewardVersionDraft).toHaveBeenCalledWith(1, {
      rewardKind: 'FIXED_AMOUNT',
      valueConfig: {
        multiCurrency: true,
        currencyValues: [
          { currency: 'MYR', value: 25 },
          { currency: 'SGD', value: 8.5 },
        ],
      },
    });
  });

  it('TC-8: a tenant with a single supported currency renders one row and still submits', async () => {
    mockUseTenantCurrenciesQuery.mockReturnValue({
      data: [currency('MYR', true)],
      isLoading: false,
    });
    const user = userEvent.setup();
    renderModal();

    await fillRequiredFields(user);
    await user.click(screen.getByRole('combobox', { name: /^kind$/i }));
    await user.click(screen.getByRole('option', { name: 'Fixed amount' }));
    await user.click(screen.getByRole('switch', { name: /one amount per currency/i }));

    expect(screen.getByLabelText(/amount in MYR/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/amount in SGD/i)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/amount in MYR/i), '25');
    await user.click(screen.getByRole('button', { name: /create reward/i }));

    expect(mockCreateRewardVersionDraft).toHaveBeenCalledWith(1, {
      rewardKind: 'FIXED_AMOUNT',
      valueConfig: { multiCurrency: true, currencyValues: [{ currency: 'MYR', value: 25 }] },
    });
  });

  it('TC-3: PERCENTAGE shows a single percentage field and no currency UI at all', async () => {
    const user = userEvent.setup();
    renderModal();

    await fillRequiredFields(user);
    await user.click(screen.getByRole('combobox', { name: /^kind$/i }));
    await user.click(screen.getByRole('option', { name: 'Percentage' }));

    expect(screen.getByRole('textbox', { name: /^percentage$/i })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /^currency$/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: /one amount per currency/i }),
    ).not.toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /^percentage$/i }), '5');
    await user.click(screen.getByRole('button', { name: /create reward/i }));

    expect(mockCreateRewardVersionDraft).toHaveBeenCalledWith(1, {
      rewardKind: 'PERCENTAGE',
      valueConfig: { percentage: 5 },
    });
  });

  it('rejects a percentage above 100 client-side, against the shared schema — no request fires', async () => {
    const user = userEvent.setup();
    renderModal();

    await fillRequiredFields(user);
    await user.click(screen.getByRole('combobox', { name: /^kind$/i }));
    await user.click(screen.getByRole('option', { name: 'Percentage' }));
    await user.type(screen.getByRole('textbox', { name: /^percentage$/i }), '150');

    await user.click(screen.getByRole('button', { name: /create reward/i }));

    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(/percentage/i);
  });

  it('creates no version draft at all when no Kind is chosen — a Kind-less version is legitimate', async () => {
    const user = userEvent.setup();
    renderModal();

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create reward/i }));

    expect(mockMutateAsync).toHaveBeenCalled();
    expect(mockCreateRewardVersionDraft).not.toHaveBeenCalled();
  });

  it('reports a created reward whose Kind draft failed, instead of closing as if it had saved', async () => {
    mockCreateRewardVersionDraft.mockRejectedValue(
      new ApiError({
        code: 'VERSION_DRAFT_EXISTS',
        message: 'A draft already exists.',
        status: 409,
      }),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('combobox', { name: /^kind$/i }));
    await user.click(screen.getByRole('option', { name: 'Points' }));
    await user.type(screen.getByRole('textbox', { name: /^points$/i }), '100');
    await user.click(screen.getByRole('button', { name: /create reward/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('CASHBACK_STANDARD was created');
    expect(alert).toHaveTextContent('A draft already exists.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('asks a super_admin which tenant supplies the currency list — they have no tenant scope of their own', async () => {
    const user = userEvent.setup();
    renderModal(vi.fn(), null);

    await user.click(screen.getByRole('combobox', { name: /^kind$/i }));
    await user.click(screen.getByRole('option', { name: 'Fixed amount' }));

    expect(screen.getByRole('combobox', { name: /currency context/i })).toBeInTheDocument();
  });

  it('never asks a tenant-scoped author for a currency context — their scope already answers it', async () => {
    const user = userEvent.setup();
    renderModal(vi.fn(), 3);

    await user.click(screen.getByRole('combobox', { name: /^kind$/i }));
    await user.click(screen.getByRole('option', { name: 'Fixed amount' }));

    expect(screen.queryByRole('combobox', { name: /currency context/i })).not.toBeInTheDocument();
  });
});
