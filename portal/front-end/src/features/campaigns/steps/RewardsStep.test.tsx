/**
 * T-127 TC-3/TC-4/TC-6 — step 5's attach flow once one of the rewards on offer is a `PROMO_CODE`.
 *
 * The three propositions worth proving here, none of which a level-specific branch could satisfy:
 *
 *  - the picker appears at **campaign** level (TC-3) and at **component** level (TC-4) alike, and
 *    would appear at tracker level too — the reward's Kind decides, never the slot;
 *  - a non-`PROMO_CODE` reward's flow is untouched, right down to the attach payload (TC-6);
 *  - a `PROMO_CODE` reward is not offered at a level its own `bindLevels` excludes — the same rule
 *    `BindingsService.assertPromoCodeAttachable` enforces server-side, so the UI can never offer
 *    something the server would refuse.
 *
 * `lib/apiClient` is the mock seam (not the query hook), for the reason
 * `PromoCodeConfigPicker.test.tsx` states: the real fetch/parse/`toApiError` path runs, and the
 * 501 these tests feed it is exactly what T-123 answers for a `planned` provider today.
 */
import type { ComponentProps } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders } from 'axios';
import type { Journey, RewardOption } from '@reward-portal/shared';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('../../../lib/apiClient', () => ({ api: { get: mockGet } }));

import { RewardsStep } from './RewardsStep';

const CASH_REWARD: RewardOption = {
  rewardPolicyId: 11,
  policyCode: 'POL_CASH',
  policyName: 'Standard cashback',
  rewardId: 1,
  rewardName: 'Cashback',
  rewardType: 'monetary',
  rewardVersionId: 101,
  unitType: 'currency',
  unitCode: 'MYR',
  amount: '10',
  rewardKind: null,
  promoCodeBindLevels: null,
};

const PROMO_REWARD: RewardOption = {
  rewardPolicyId: 22,
  policyCode: 'POL_PROMO',
  policyName: 'Raya promo',
  rewardId: 2,
  rewardName: 'Promo code',
  rewardType: 'voucher',
  rewardVersionId: 202,
  unitType: null,
  unitCode: null,
  amount: null,
  rewardKind: 'PROMO_CODE',
  promoCodeBindLevels: ['component', 'tracker', 'campaign'],
};

/** The same Kind, but authorable at component level only — the bind-level gate's negative case. */
const PROMO_COMPONENT_ONLY: RewardOption = {
  ...PROMO_REWARD,
  rewardPolicyId: 33,
  policyCode: 'POL_PROMO_COMP',
  policyName: 'Component-only promo',
  promoCodeBindLevels: ['component'],
};

/** A `FIXED_AMOUNT` reward whose author left no amount — the Maker supplies it at attach time. */
const CASHBACK_UNSET_REWARD: RewardOption = {
  rewardPolicyId: 44,
  policyCode: 'POL_CASH_UNSET',
  policyName: 'Signup cashback',
  rewardId: 4,
  rewardName: 'Cashback',
  rewardType: 'monetary',
  rewardVersionId: 401,
  unitType: 'currency',
  unitCode: null,
  amount: null,
  rewardKind: 'FIXED_AMOUNT',
  promoCodeBindLevels: null,
};

/** A `POINTS` reward left unset the same way. */
const POINTS_UNSET_REWARD: RewardOption = {
  rewardPolicyId: 55,
  policyCode: 'POL_POINTS_UNSET',
  policyName: 'Loyalty stripes',
  rewardId: 5,
  rewardName: 'Stripe points',
  rewardType: 'points',
  rewardVersionId: 501,
  unitType: 'points',
  unitCode: null,
  amount: null,
  rewardKind: 'POINTS',
  promoCodeBindLevels: null,
};

const JOURNEY: Journey = {
  campaignId: 1,
  campaignRewards: [],
  trackers: [
    {
      id: 7,
      linkId: 700,
      trackerCode: 'TRK-1',
      name: 'Onboarding',
      description: null,
      completionLogic: 'all',
      completionThreshold: null,
      isPrimary: true,
      status: 'active',
      rewards: [],
      components: [
        {
          id: 71,
          linkId: 710,
          componentCode: 'CMP-1',
          name: 'First purchase',
          description: null,
          activityId: 5,
          activityName: 'Purchase',
          sequenceOrder: 1,
          isMandatory: true,
          status: 'active',
          ruleLogic: null,
          ruleThreshold: null,
          rules: [],
          rewards: [],
        },
      ],
    },
  ],
};

function notAvailableYet(): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('Provider not available.', '501', config, null, {
    status: 501,
    statusText: '',
    headers: {},
    config,
    data: {
      error: {
        code: 'FIELD_LOOKUP_PROVIDER_NOT_AVAILABLE',
        message: 'Provider not available.',
        traceId: 't-1',
      },
    },
  });
}

function renderStep(
  options: readonly RewardOption[],
  overrides: Partial<ComponentProps<typeof RewardsStep>> = {},
) {
  const onAttach = vi.fn();
  const onDetach = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RewardsStep
        journey={JOURNEY}
        rewardOptions={options}
        worstCasePayout={[]}
        onAttach={onAttach}
        onDetach={onDetach}
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { onAttach, onDetach };
}

/** The three attachment slots step 5 renders, addressed the way a maker sees them. */
function campaignSlot(): HTMLElement {
  return screen.getByRole('heading', { name: 'Campaign reward' }).closest('div')!.parentElement!;
}
function componentSlot(): HTMLElement {
  return screen.getByRole('heading', { name: /first purchase/i }).parentElement!;
}

async function chooseReward(
  user: ReturnType<typeof userEvent.setup>,
  slot: HTMLElement,
  label: RegExp,
): Promise<void> {
  await user.click(within(slot).getByRole('combobox', { name: /add a reward/i }));
  await user.click(await screen.findByRole('option', { name: label }));
}

beforeEach(() => {
  mockGet.mockReset();
  mockGet.mockRejectedValue(notAvailableYet());
});

describe('RewardsStep · T-127 Promo Code', () => {
  it('TC-3: picking a PROMO_CODE reward at campaign level reveals the config picker, "not available yet"', async () => {
    const user = userEvent.setup();
    renderStep([CASH_REWARD, PROMO_REWARD]);
    const slot = campaignSlot();

    expect(within(slot).queryByTestId('promo-code-config-picker')).not.toBeInTheDocument();

    await chooseReward(user, slot, /raya promo/i);

    const picker = within(slot).getByTestId('promo-code-config-picker');
    expect(await within(picker).findByText(/not available yet/i)).toBeInTheDocument();
    expect(within(picker).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('TC-4: the same picker appears at component level — the Kind decides, not the level', async () => {
    const user = userEvent.setup();
    renderStep([CASH_REWARD, PROMO_REWARD]);
    const slot = componentSlot();

    await chooseReward(user, slot, /raya promo/i);

    const picker = within(slot).getByTestId('promo-code-config-picker');
    expect(await within(picker).findByText(/not available yet/i)).toBeInTheDocument();
  });

  it('TC-3: attaching with nothing picked still works, and sends no promo code config', async () => {
    const user = userEvent.setup();
    const { onAttach } = renderStep([PROMO_REWARD]);
    const slot = campaignSlot();

    await chooseReward(user, slot, /raya promo/i);
    await within(slot).findByTestId('promo-code-config-picker');
    await user.click(within(slot).getByRole('button', { name: /attach/i }));

    expect(onAttach).toHaveBeenCalledWith('campaign', null, 22, null, null, null);
  });

  it('passes the maker’s pick through to the attach call once the service exists', async () => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({
      data: { data: [{ value: 'RAYA_2026', label: 'Raya 2026 codes' }] },
    });
    const user = userEvent.setup();
    const { onAttach } = renderStep([PROMO_REWARD]);
    const slot = componentSlot();

    await chooseReward(user, slot, /raya promo/i);
    await user.click(await within(slot).findByRole('combobox', { name: /promo code config/i }));
    await user.click(screen.getByRole('option', { name: 'Raya 2026 codes' }));
    await user.click(within(slot).getByRole('button', { name: /attach/i }));

    expect(onAttach).toHaveBeenCalledWith('component', 71, 22, 'RAYA_2026', null, null);
  });

  it('TC-6: a non-PROMO_CODE reward shows no promo UI and attaches exactly as before', async () => {
    const user = userEvent.setup();
    const { onAttach } = renderStep([CASH_REWARD, PROMO_REWARD]);
    const slot = campaignSlot();

    await chooseReward(user, slot, /standard cashback/i);

    expect(within(slot).queryByTestId('promo-code-config-picker')).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();

    await user.click(within(slot).getByRole('button', { name: /attach/i }));
    expect(onAttach).toHaveBeenCalledWith('campaign', null, 11, null, null, null);
  });

  it('does not offer a PROMO_CODE reward at a level its bindLevels excludes', async () => {
    const user = userEvent.setup();
    renderStep([PROMO_COMPONENT_ONLY]);

    await user.click(within(campaignSlot()).getByRole('combobox', { name: /add a reward/i }));
    expect(screen.queryByRole('option', { name: /component-only promo/i })).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    await user.click(within(componentSlot()).getByRole('combobox', { name: /add a reward/i }));
    expect(screen.getByRole('option', { name: /component-only promo/i })).toBeInTheDocument();
  });

  it('clears a pick when the maker switches to a different reward in the same slot', async () => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({
      data: { data: [{ value: 'RAYA_2026', label: 'Raya 2026 codes' }] },
    });
    const user = userEvent.setup();
    const { onAttach } = renderStep([CASH_REWARD, PROMO_REWARD]);
    const slot = campaignSlot();

    await chooseReward(user, slot, /raya promo/i);
    await user.click(await within(slot).findByRole('combobox', { name: /promo code config/i }));
    await user.click(screen.getByRole('option', { name: 'Raya 2026 codes' }));

    // Switch to the cashback reward: the promo pick must not ride along with it.
    await chooseReward(user, slot, /standard cashback/i);
    await user.click(within(slot).getByRole('button', { name: /attach/i }));

    expect(onAttach).toHaveBeenCalledWith('campaign', null, 11, null, null, null);
  });
});

/**
 * Cashback/points — the `FIXED_AMOUNT`/`POINTS` siblings of T-127's promo code flow above. A
 * reward whose author left no amount at creation time exposes an input here instead of the
 * promo-code picker, gated the identical way: the Kind decides, never the level, and the Attach
 * button stays disabled until the value is supplied (unlike promo code, there is no legitimate
 * reason to attach one of these with the value permanently unset).
 */
describe('RewardsStep · cashback and points left unset at creation time', () => {
  it('reveals a cashback amount + currency input for a FIXED_AMOUNT reward with no amount', async () => {
    const user = userEvent.setup();
    const { onAttach } = renderStep([CASHBACK_UNSET_REWARD]);
    const slot = campaignSlot();

    await chooseReward(user, slot, /signup cashback/i);

    expect(within(slot).getByLabelText(/cashback amount/i)).toBeInTheDocument();
    // Nothing supplied yet — the button must not let an unset amount through.
    expect(within(slot).getByRole('button', { name: /attach/i })).toBeDisabled();

    await user.type(within(slot).getByLabelText(/cashback amount/i), '25.50');
    await user.type(within(slot).getByLabelText(/^currency/i), 'myr');
    expect(within(slot).getByRole('button', { name: /attach/i })).toBeEnabled();

    await user.click(within(slot).getByRole('button', { name: /attach/i }));
    expect(onAttach).toHaveBeenCalledWith(
      'campaign',
      null,
      44,
      null,
      { amount: '25.50', currency: 'MYR' },
      null,
    );
  });

  it('reveals a points input for a POINTS reward with no amount', async () => {
    const user = userEvent.setup();
    const { onAttach } = renderStep([POINTS_UNSET_REWARD]);
    const slot = campaignSlot();

    await chooseReward(user, slot, /loyalty stripes/i);

    expect(within(slot).getByRole('button', { name: /attach/i })).toBeDisabled();
    await user.type(within(slot).getByLabelText('Points'), '250');
    expect(within(slot).getByRole('button', { name: /attach/i })).toBeEnabled();

    await user.click(within(slot).getByRole('button', { name: /attach/i }));
    expect(onAttach).toHaveBeenCalledWith('campaign', null, 55, null, null, 250);
  });

  it('a reward that already has an amount shows no input at all — nothing left for the Maker to set', () => {
    renderStep([CASH_REWARD]);
    const slot = campaignSlot();

    expect(within(slot).queryByLabelText(/cashback amount/i)).not.toBeInTheDocument();
  });

  it('clears a cashback pick when the maker switches to a different reward in the same slot', async () => {
    const user = userEvent.setup();
    const { onAttach } = renderStep([CASHBACK_UNSET_REWARD, CASH_REWARD]);
    const slot = campaignSlot();

    await chooseReward(user, slot, /signup cashback/i);
    await user.type(within(slot).getByLabelText(/cashback amount/i), '25.50');
    await user.type(within(slot).getByLabelText(/^currency/i), 'MYR');

    // Switch to the already-priced reward: the cashback input must disappear, and the attach
    // call must carry no leftover pick.
    await chooseReward(user, slot, /standard cashback/i);
    expect(within(slot).queryByLabelText(/cashback amount/i)).not.toBeInTheDocument();

    await user.click(within(slot).getByRole('button', { name: /attach/i }));
    expect(onAttach).toHaveBeenCalledWith('campaign', null, 11, null, null, null);
  });
});

/**
 * The step-5 behaviour T-037 already shipped, kept green while T-127 changed the same component.
 * There was no test file for this step before this task; these cases exist so a regression in the
 * parts T-127 *didn't* mean to touch shows up here rather than in a maker's browser.
 */
describe('RewardsStep · step 5 as T-037 built it', () => {
  it('shows every attachment point, including the empty ones — that is the information', () => {
    renderStep([]);

    expect(screen.getByRole('heading', { name: 'Campaign reward' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Onboarding' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /first purchase/i })).toBeInTheDocument();
    // One "No reward here" line per empty slot: campaign, tracker and component.
    expect(screen.getAllByText(/no reward here/i)).toHaveLength(3);
  });

  it('warns when nothing is attached anywhere, because such a campaign cannot be submitted', () => {
    renderStep([]);
    expect(screen.getByText(/no reward is attached anywhere yet/i)).toBeInTheDocument();
  });

  it('reports the worst case per unit, and never adds two units together', () => {
    renderStep([], {
      worstCasePayout: [
        {
          unitType: 'currency',
          unitCode: 'MYR',
          perCustomerAmount: '15',
          attachmentCount: 2,
          hasUnknownAmounts: false,
        },
        {
          unitType: 'points',
          unitCode: 'PTS',
          perCustomerAmount: '100',
          attachmentCount: 1,
          hasUnknownAmounts: true,
        },
      ],
    });

    expect(screen.getByText('15 MYR')).toBeInTheDocument();
    expect(screen.getByText('100 PTS')).toBeInTheDocument();
    // "At least" only on the line that has an unpriced attachment — a floor, not a total.
    expect(screen.getByText(/at least/i)).toBeInTheDocument();
    expect(screen.getByText(/units are never added together/i)).toBeInTheDocument();
  });

  it('lists an attached reward with its amount, and detaches it on request', async () => {
    const user = userEvent.setup();
    const { onDetach } = renderStep([], {
      journey: {
        ...JOURNEY,
        campaignRewards: [
          {
            level: 'campaign' as const,
            refId: null,
            id: 501,
            rewardPolicyId: 11,
            rewardPolicyName: 'Standard cashback',
            rewardId: 1,
            rewardName: 'Cashback',
            rewardVersionId: 101,
            unitType: 'currency',
            unitCode: 'MYR',
            amount: '10',
            promoCodeConfigId: null,
            status: 'active',
          },
        ],
      },
    });

    const slot = campaignSlot();
    expect(within(slot).getByText('10 MYR')).toBeInTheDocument();

    await user.click(within(slot).getByRole('button', { name: /remove/i }));
    expect(onDetach).toHaveBeenCalledWith('campaign', 501);
  });

  it('offers nothing, and says so, once every available reward is already attached', () => {
    renderStep([CASH_REWARD], {
      journey: {
        ...JOURNEY,
        campaignRewards: [
          {
            level: 'campaign' as const,
            refId: null,
            id: 502,
            rewardPolicyId: 11,
            rewardPolicyName: 'Standard cashback',
            rewardId: 1,
            rewardName: 'Cashback',
            rewardVersionId: 101,
            unitType: 'currency',
            unitCode: 'MYR',
            amount: '10',
            promoCodeConfigId: null,
            status: 'active',
          },
        ],
      },
    });

    const picker = within(campaignSlot()).getByRole('combobox', { name: /add a reward/i });
    expect(picker).toBeDisabled();
    expect(picker).toHaveTextContent(/no further rewards available/i);
  });

  it('renders an empty state, not a broken tree, before a journey exists', () => {
    renderStep([], { journey: undefined });
    expect(screen.getByText(/no journey yet/i)).toBeInTheDocument();
  });
});
