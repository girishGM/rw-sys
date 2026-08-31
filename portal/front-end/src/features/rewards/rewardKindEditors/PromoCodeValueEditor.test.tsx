/**
 * T-127 TC-1/TC-2 — authoring a reward whose Kind is `PROMO_CODE`.
 *
 * The `value_config` assertions are made against `rewardVersionValueSchema` — the same shared
 * discriminated union the server validates with — rather than against a literal this file writes
 * down. A test that restated the shape would pass even if the shape were wrong (AGENT-PROTOCOL §3);
 * this one fails whenever what the editor builds is something `POST /rewards/:id/versions` would
 * reject.
 *
 * TC-2 ("no bind levels selected → client-side validation blocks submit") is asserted where the
 * user would actually experience it, on `AddRewardModal`: the observable property is *no request
 * was sent*, not *a helper returned `invalid`*. That modal is T-120's file, so it is exercised
 * here rather than edited there.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { rewardVersionValueSchema } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../../auth/useBootstrap';

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

vi.mock('../api', () => ({ useCreateRewardMutation: mockUseCreateRewardMutation }));
vi.mock('../../tenants/api', () => ({ useTenantsQuery: mockUseTenantsQuery }));
// `buildValueConfig` stays real — it is what turns these checkboxes into the payload under test.
vi.mock('../rewardValue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../rewardValue')>()),
  useRewardCategoriesQuery: mockUseRewardCategoriesQuery,
  useRewardSubCategoriesQuery: mockUseRewardSubCategoriesQuery,
  useTenantCurrenciesQuery: mockUseTenantCurrenciesQuery,
  createRewardVersionDraft: mockCreateRewardVersionDraft,
}));

import { AddRewardModal } from '../AddRewardModal';
import { PromoCodeValueEditor } from './PromoCodeValueEditor';
import {
  EMPTY_REWARD_VALUE_DRAFT,
  PROMO_CODE_API_PROVIDER,
  buildValueConfig,
  draftFromVersion,
  type RewardValueDraft,
} from '../rewardValue';

const CATEGORIES = [{ id: 9, categoryCode: 'VOUCHER', name: 'Voucher', status: 'active' }];
const SUB_CATEGORIES = [
  { id: 31, categoryId: 9, subCategoryCode: 'PROMO_CODE', name: 'Promo Code', status: 'active' },
];

const createdReward = {
  id: 5,
  systemCode: 'PROMO_STANDARD',
  name: 'Standard promo code',
  description: null,
  rewardType: 'voucher',
  deliveryMode: 'realtime',
  connectorType: 'internal_api',
  connectorConfig: null,
  maintenanceWindowEnabled: false,
  maintenanceSchedule: {},
  retryEnabled: true,
  retryConfig: {},
  merchantId: null,
  categoryId: 9,
  categoryName: 'Voucher',
  subCategoryId: 31,
  subCategoryName: 'Promo Code',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function bootstrapValue(): BootstrapContextValue {
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
    hasPermission: () => true,
    refetch: () => undefined,
  };
}

function renderEditor(draft: RewardValueDraft) {
  const onChange = vi.fn();
  render(
    <PromoCodeValueEditor
      draft={draft}
      onChange={onChange}
      currencies={[]}
      currenciesLoading={false}
    />,
  );
  return onChange;
}

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue()}>
        <AddRewardModal open onClose={vi.fn()} />
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/system code/i), 'PROMO_STANDARD');
  await user.type(screen.getByLabelText(/^name$/i), 'Standard promo code');
  await user.type(screen.getByLabelText(/reward type/i), 'voucher');
  await user.click(screen.getByRole('combobox', { name: /connector type/i }));
  await user.click(screen.getByRole('option', { name: 'internal_api' }));
  await user.click(screen.getByRole('combobox', { name: /^category$/i }));
  await user.click(screen.getByRole('option', { name: 'Voucher' }));
  await user.click(screen.getByRole('combobox', { name: /^kind$/i }));
  await user.click(screen.getByRole('option', { name: 'Promo code' }));
}

/**
 * The design-system `MultiSelect` is a popover, not a `<select>`: open it once, tick every level,
 * then close. Re-clicking the trigger between ticks would *toggle it shut*, which is what made the
 * first draft of this helper fail on the second level.
 */
async function pickBindLevels(
  user: ReturnType<typeof userEvent.setup>,
  labels: readonly RegExp[],
): Promise<void> {
  await user.click(screen.getByRole('button', { name: /where can this be attached/i }));
  for (const label of labels) {
    await user.click(screen.getByRole('option', { name: label }));
  }
  await user.keyboard('{Escape}');
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
  mockCreateRewardVersionDraft.mockResolvedValue({ id: 901, rewardId: 5, versionNo: 1 });
  mockUseRewardCategoriesQuery.mockReturnValue({ data: CATEGORIES, isLoading: false });
  mockUseRewardSubCategoriesQuery.mockReturnValue({ data: SUB_CATEGORIES, isLoading: false });
  mockUseTenantCurrenciesQuery.mockReturnValue({ data: [], isLoading: false });
  mockUseTenantsQuery.mockReturnValue({
    data: { data: [], meta: { page: 1, pageSize: 100, total: 0 } },
    isLoading: false,
  });
});

describe('PromoCodeValueEditor', () => {
  it('offers no amount or currency field at all — §5: this Kind carries no amount', () => {
    renderEditor({ ...EMPTY_REWARD_VALUE_DRAFT, kind: 'PROMO_CODE' });

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /currency/i })).not.toBeInTheDocument();
  });

  it('states the config service read-only, rather than offering a pick of exactly one', () => {
    renderEditor({ ...EMPTY_REWARD_VALUE_DRAFT, kind: 'PROMO_CODE' });

    expect(screen.getByText(PROMO_CODE_API_PROVIDER)).toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: /promo code config service/i }),
    ).not.toBeInTheDocument();
  });

  it('says plainly that the service is not available yet', () => {
    renderEditor({ ...EMPTY_REWARD_VALUE_DRAFT, kind: 'PROMO_CODE' });
    expect(screen.getByText(/not available yet/i)).toBeInTheDocument();
  });

  it('reports a ticked level back in the vocabulary’s order, not in click order', async () => {
    const user = userEvent.setup();
    const onChange = renderEditor({
      ...EMPTY_REWARD_VALUE_DRAFT,
      kind: 'PROMO_CODE',
      promoCodeBindLevels: ['campaign'],
    });

    await user.click(screen.getByRole('button', { name: /where can this be attached/i }));
    await user.click(screen.getByRole('option', { name: /^component/i }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ promoCodeBindLevels: ['component', 'campaign'] }),
    );
  });
});

describe('buildValueConfig for PROMO_CODE', () => {
  it('TC-1: all three levels produce a config the shared schema accepts', () => {
    const result = buildValueConfig({
      ...EMPTY_REWARD_VALUE_DRAFT,
      kind: 'PROMO_CODE',
      promoCodeBindLevels: ['campaign', 'component', 'tracker'],
    });

    expect(result.state).toBe('ok');
    if (result.state !== 'ok') return;
    expect(
      rewardVersionValueSchema.safeParse({
        rewardKind: result.rewardKind,
        valueConfig: result.valueConfig,
      }).success,
    ).toBe(true);
    expect(result.valueConfig).toEqual({
      apiProvider: 'PROMO_CODE_CONFIG_SERVICE',
      bindLevels: ['component', 'tracker', 'campaign'],
    });
  });

  it('TC-1: carries no amount, currency or points key whatever else the draft holds', () => {
    const result = buildValueConfig({
      ...EMPTY_REWARD_VALUE_DRAFT,
      kind: 'PROMO_CODE',
      promoCodeBindLevels: ['campaign'],
      // Left over from the author trying Fixed Amount first — must never reach the wire.
      defaultCurrency: 'MYR',
      defaultValue: '25',
      points: '100',
    });

    expect(result.state).toBe('ok');
    if (result.state !== 'ok') return;
    expect(Object.keys(result.valueConfig).sort()).toEqual(['apiProvider', 'bindLevels']);
  });

  it('TC-2: no bind level is invalid — `bindLevels` is `.min(1)` in the shared schema', () => {
    const result = buildValueConfig({
      ...EMPTY_REWARD_VALUE_DRAFT,
      kind: 'PROMO_CODE',
      promoCodeBindLevels: [],
    });
    expect(result.state).toBe('invalid');
  });

  it('round-trips a stored config back into the editor unchanged', () => {
    const stored = {
      rewardKind: 'PROMO_CODE' as const,
      valueConfig: {
        apiProvider: 'PROMO_CODE_CONFIG_SERVICE',
        bindLevels: ['component', 'campaign'],
      },
    };
    expect(buildValueConfig(draftFromVersion(stored))).toEqual({
      state: 'ok',
      rewardKind: 'PROMO_CODE',
      valueConfig: stored.valueConfig,
    });
  });

  it('survives a stored config whose bindLevels are junk, instead of throwing', () => {
    expect(
      draftFromVersion({ rewardKind: 'PROMO_CODE', valueConfig: { bindLevels: 'nope' } })
        .promoCodeBindLevels,
    ).toEqual([]);
    expect(
      draftFromVersion({
        rewardKind: 'PROMO_CODE',
        valueConfig: { bindLevels: ['component', 'not-a-level'] },
      }).promoCodeBindLevels,
    ).toEqual(['component']);
  });
});

describe('AddRewardModal with Kind = PROMO_CODE', () => {
  it('TC-1: creates the reward, then authors the Kind on a draft version', async () => {
    const user = userEvent.setup();
    renderModal();

    await fillRequiredFields(user);
    await pickBindLevels(user, [/^component/i, /^tracker/i, /^campaign/i]);
    await user.click(screen.getByRole('button', { name: /create reward/i }));

    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockCreateRewardVersionDraft).toHaveBeenCalledWith(5, {
      rewardKind: 'PROMO_CODE',
      valueConfig: {
        apiProvider: 'PROMO_CODE_CONFIG_SERVICE',
        bindLevels: ['component', 'tracker', 'campaign'],
      },
    });
  });

  it('TC-2: with no bind level ticked, nothing is sent and the form says why', async () => {
    const user = userEvent.setup();
    renderModal();

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create reward/i }));

    // The observable property: no reward was created and no version was authored.
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(mockCreateRewardVersionDraft).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(/bindLevels/i);
  });
});
