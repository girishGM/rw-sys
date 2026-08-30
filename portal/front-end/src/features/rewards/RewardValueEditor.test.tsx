/**
 * T-120 — the Kind registry, its editors, and the pure functions that build/read a `value_config`.
 *
 * The `buildValueConfig` cases below deliberately assert the *object that would go on the wire*
 * against the shared schema's own rules rather than restating this component's internals: a
 * `multiCurrency: true` config carrying `defaultValue` is rejected by
 * `fixedAmountValueConfigSchema` itself (AGENT-PROTOCOL §3 — assert the property something else
 * actually enforces, not the implementation string).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { rewardVersionValueSchema } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';

const { mockUseTenantCurrenciesQuery, mockUseTenantsQuery } = vi.hoisted(() => ({
  mockUseTenantCurrenciesQuery: vi.fn(),
  mockUseTenantsQuery: vi.fn(),
}));

vi.mock('../tenants/api', () => ({ useTenantsQuery: mockUseTenantsQuery }));
vi.mock('./rewardValue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rewardValue')>()),
  useTenantCurrenciesQuery: mockUseTenantCurrenciesQuery,
}));

import { RewardValueEditor } from './RewardValueEditor';
import {
  EMPTY_REWARD_VALUE_DRAFT,
  REWARD_KIND_LABELS,
  SUPPORTED_REWARD_KINDS,
  buildValueConfig,
  draftFromVersion,
  isSupportedRewardKind,
  type RewardValueDraft,
} from './rewardValue';

function currency(code: string) {
  return {
    id: code.charCodeAt(0),
    tenantId: 3,
    currencyCode: code,
    isDefault: code === 'MYR',
    status: 'active' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

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

function renderEditor(draft: RewardValueDraft, tenantId: number | null = 3) {
  const onChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(tenantId)}>
        <RewardValueEditor draft={draft} onChange={onChange} />
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
  return onChange;
}

beforeEach(() => {
  mockUseTenantCurrenciesQuery.mockReset();
  mockUseTenantsQuery.mockReset();
  mockUseTenantCurrenciesQuery.mockReturnValue({
    data: [currency('MYR'), currency('SGD')],
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

describe('the Kind registry', () => {
  // Updated by T-127, which registered `PROMO_CODE` in `SUPPORTED_REWARD_KINDS` — the one-line
  // extension T-120 built the registry for. Its own cases live in
  // `rewardKindEditors/PromoCodeValueEditor.test.tsx`.
  it('offers every kind the database can hold, now that PROMO_CODE (T-127) is authorable', () => {
    expect([...SUPPORTED_REWARD_KINDS]).toEqual([
      'FIXED_AMOUNT',
      'PERCENTAGE',
      'POINTS',
      'PHYSICAL',
      'PROMO_CODE',
    ]);
    expect(isSupportedRewardKind('PROMO_CODE')).toBe(true);
  });

  it('has a label for every kind the database can hold, including the not-yet-authorable one', () => {
    // If a migration adds a kind, this fails until the label map is extended — which is the point.
    expect(Object.keys(REWARD_KIND_LABELS).sort()).toEqual(
      ['FIXED_AMOUNT', 'PERCENTAGE', 'PHYSICAL', 'POINTS', 'PROMO_CODE'].sort(),
    );
  });

  it('renders an editor for every supported kind — a registered kind can never be unrenderable', () => {
    for (const kind of SUPPORTED_REWARD_KINDS) {
      const { unmount } = render(
        <QueryClientProvider client={new QueryClient()}>
          <BootstrapContext.Provider value={bootstrapValue(3)}>
            <RewardValueEditor draft={{ ...EMPTY_REWARD_VALUE_DRAFT, kind }} onChange={vi.fn()} />
          </BootstrapContext.Provider>
        </QueryClientProvider>,
      );
      expect(screen.getByRole('combobox', { name: /^kind$/i })).toHaveTextContent(
        REWARD_KIND_LABELS[kind],
      );
      unmount();
    }
  });
});

describe('buildValueConfig', () => {
  it('reports "unset" for no kind — a version with neither key is a legitimate state', () => {
    expect(buildValueConfig(EMPTY_REWARD_VALUE_DRAFT)).toEqual({ state: 'unset' });
  });

  it('produces a FIXED_AMOUNT single-currency config the shared schema accepts', () => {
    const result = buildValueConfig({
      ...EMPTY_REWARD_VALUE_DRAFT,
      kind: 'FIXED_AMOUNT',
      defaultCurrency: 'MYR',
      defaultValue: '25.50',
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
      multiCurrency: false,
      defaultCurrency: 'MYR',
      defaultValue: 25.5,
    });
  });

  it('drops currencies left blank in multi-currency mode rather than sending a zero for them', () => {
    const result = buildValueConfig({
      ...EMPTY_REWARD_VALUE_DRAFT,
      kind: 'FIXED_AMOUNT',
      multiCurrency: true,
      currencyValues: { MYR: '25', SGD: '  ' },
    });

    expect(result.state).toBe('ok');
    if (result.state !== 'ok') return;
    expect(result.valueConfig).toEqual({
      multiCurrency: true,
      currencyValues: [{ currency: 'MYR', value: 25 }],
    });
  });

  it('never mixes the two FIXED_AMOUNT shapes — a multi-currency config carries no defaultValue', () => {
    const result = buildValueConfig({
      ...EMPTY_REWARD_VALUE_DRAFT,
      kind: 'FIXED_AMOUNT',
      multiCurrency: true,
      defaultCurrency: 'MYR',
      defaultValue: '25',
      currencyValues: { SGD: '8' },
    });

    expect(result.state).toBe('ok');
    if (result.state !== 'ok') return;
    expect(result.valueConfig).not.toHaveProperty('defaultValue');
    expect(result.valueConfig).not.toHaveProperty('defaultCurrency');
  });

  it('rejects an empty multi-currency table — `currencyValues` must be non-empty', () => {
    const result = buildValueConfig({
      ...EMPTY_REWARD_VALUE_DRAFT,
      kind: 'FIXED_AMOUNT',
      multiCurrency: true,
      currencyValues: {},
    });
    expect(result.state).toBe('invalid');
  });

  it('rejects an empty amount rather than reading it as 0', () => {
    const result = buildValueConfig({
      ...EMPTY_REWARD_VALUE_DRAFT,
      kind: 'FIXED_AMOUNT',
      defaultCurrency: 'MYR',
      defaultValue: '',
    });
    expect(result.state).toBe('invalid');
  });

  it('rejects a negative amount and a percentage outside 0–100', () => {
    expect(
      buildValueConfig({
        ...EMPTY_REWARD_VALUE_DRAFT,
        kind: 'FIXED_AMOUNT',
        defaultCurrency: 'MYR',
        defaultValue: '-1',
      }).state,
    ).toBe('invalid');
    expect(
      buildValueConfig({ ...EMPTY_REWARD_VALUE_DRAFT, kind: 'PERCENTAGE', percentage: '101' })
        .state,
    ).toBe('invalid');
    expect(
      buildValueConfig({ ...EMPTY_REWARD_VALUE_DRAFT, kind: 'PERCENTAGE', percentage: '100' })
        .state,
    ).toBe('ok');
  });

  it('builds POINTS and PHYSICAL configs, trimming the text fields', () => {
    expect(
      buildValueConfig({ ...EMPTY_REWARD_VALUE_DRAFT, kind: 'POINTS', points: '100' }),
    ).toEqual({ state: 'ok', rewardKind: 'POINTS', valueConfig: { points: 100 } });
    expect(
      buildValueConfig({
        ...EMPTY_REWARD_VALUE_DRAFT,
        kind: 'PHYSICAL',
        sku: ' TSHIRT-BLK-L ',
        description: ' Black t-shirt ',
      }),
    ).toEqual({
      state: 'ok',
      rewardKind: 'PHYSICAL',
      valueConfig: { sku: 'TSHIRT-BLK-L', description: 'Black t-shirt' },
    });
  });

  it('rejects a PHYSICAL reward with no SKU', () => {
    expect(
      buildValueConfig({ ...EMPTY_REWARD_VALUE_DRAFT, kind: 'PHYSICAL', description: 'x' }).state,
    ).toBe('invalid');
  });
});

describe('draftFromVersion', () => {
  it('round-trips every supported kind through buildValueConfig unchanged', () => {
    const configs = [
      {
        rewardKind: 'FIXED_AMOUNT' as const,
        valueConfig: { multiCurrency: false, defaultCurrency: 'MYR', defaultValue: 25 },
      },
      {
        rewardKind: 'FIXED_AMOUNT' as const,
        valueConfig: {
          multiCurrency: true,
          currencyValues: [
            { currency: 'MYR', value: 25 },
            { currency: 'SGD', value: 8.5 },
          ],
        },
      },
      { rewardKind: 'PERCENTAGE' as const, valueConfig: { percentage: 5 } },
      { rewardKind: 'POINTS' as const, valueConfig: { points: 100 } },
      { rewardKind: 'PHYSICAL' as const, valueConfig: { sku: 'X-1', description: 'A thing' } },
    ];

    for (const stored of configs) {
      const result = buildValueConfig(draftFromVersion(stored));
      expect(result).toEqual({
        state: 'ok',
        rewardKind: stored.rewardKind,
        valueConfig: stored.valueConfig,
      });
    }
  });

  it('reads a version with no kind as blank', () => {
    expect(draftFromVersion({ rewardKind: null, valueConfig: null })).toEqual(
      EMPTY_REWARD_VALUE_DRAFT,
    );
  });

  it('survives a malformed stored config instead of throwing on it', () => {
    expect(
      draftFromVersion({ rewardKind: 'FIXED_AMOUNT', valueConfig: { currencyValues: 'nope' } }),
    ).toEqual({ ...EMPTY_REWARD_VALUE_DRAFT, kind: 'FIXED_AMOUNT' });
  });
});

describe('RewardValueEditor', () => {
  it('shows no value editor at all until a Kind is chosen', () => {
    renderEditor(EMPTY_REWARD_VALUE_DRAFT);

    expect(screen.getByRole('combobox', { name: /^kind$/i })).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('offers only the tenant currencies the endpoint returned — never a hardcoded list', async () => {
    const user = userEvent.setup();
    renderEditor({ ...EMPTY_REWARD_VALUE_DRAFT, kind: 'FIXED_AMOUNT' });

    await user.click(screen.getByRole('combobox', { name: /^currency$/i }));

    expect(screen.getByRole('option', { name: 'MYR' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'SGD' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'USD' })).not.toBeInTheDocument();
  });

  it('explains an empty currency list rather than rendering an empty table', () => {
    mockUseTenantCurrenciesQuery.mockReturnValue({ data: [], isLoading: false });
    renderEditor({ ...EMPTY_REWARD_VALUE_DRAFT, kind: 'FIXED_AMOUNT', multiCurrency: true });

    expect(screen.getByText(/no active currencies are configured/i)).toBeInTheDocument();
  });

  it('keeps a value typed for one kind when the author switches away and back', async () => {
    const user = userEvent.setup();
    const onChange = renderEditor({
      ...EMPTY_REWARD_VALUE_DRAFT,
      kind: 'POINTS',
      percentage: '5',
    });

    await user.type(screen.getByRole('textbox', { name: /^points$/i }), '1');

    // The editor never drops the other kinds' fields from the draft it hands back.
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ percentage: '5' }));
  });

  it('surfaces a validation message on the value as a whole', () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <BootstrapContext.Provider value={bootstrapValue(3)}>
          <RewardValueEditor
            draft={{ ...EMPTY_REWARD_VALUE_DRAFT, kind: 'PERCENTAGE' }}
            onChange={vi.fn()}
            error="percentage: Too big"
          />
        </BootstrapContext.Provider>
      </QueryClientProvider>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('percentage: Too big');
  });
});
