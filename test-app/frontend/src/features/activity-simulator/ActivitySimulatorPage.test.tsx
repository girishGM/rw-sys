/**
 * T-010 — the Activity Simulator page's own wiring test (TC-1..TC-8, minus TC-6/TC-7 which are
 * this task's own live-verification/viewport checks rather than something a jsdom unit test can
 * meaningfully prove): submitting a real activity drives the inline status line from the real
 * `POST /api/activities` response, a `reward-earned` SSE event (not the mutation response) drives
 * the toast, "View in My Rewards" really points at `/rewards`, a customer switch resets both and
 * refetches that customer's own feed, and the submit button disables while a request is in flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as apiClient from '../../lib/apiClient';
import { sseBus } from '../../lib/sseClient';
import { CustomerContext, type CustomerContextValue } from '../../app/useCustomer';
import { ActivitySimulatorPage } from './ActivitySimulatorPage';
import type { ActivityResult, CampaignDetail, CampaignSummary, Customer } from '../../types';

const PRIYA: Customer = { id: 'priya-shah', displayName: 'Priya Shah', avatarInitials: 'PS' };
const MARCUS: Customer = { id: 'marcus-tan', displayName: 'Marcus Tan', avatarInitials: 'MT' };

function customerValue(customer: Customer): CustomerContextValue {
  return {
    customers: [PRIYA, MARCUS],
    customerId: customer.id,
    customer,
    isLoading: false,
    setCustomerId: () => {},
  };
}

const SUMMER: CampaignSummary = {
  campaignId: 1,
  campaignCode: 'SUMMER_CASHBACK_SPRINT',
  name: 'Summer Cashback Sprint',
  description: null,
  startDate: '2026-06-01',
  endDate: '2026-08-31',
  status: 'active',
  progress: null,
};

function summerDetail(): CampaignDetail {
  return {
    campaignId: 1,
    campaignCode: 'SUMMER_CASHBACK_SPRINT',
    name: 'Summer Cashback Sprint',
    description: null,
    startDate: '2026-06-01',
    endDate: '2026-08-31',
    status: 'active',
    campaignRewards: [],
    trackers: [
      {
        trackerId: 10,
        trackerCode: 'SCS_TRACKER',
        trackerName: 'Grocery Streak',
        description: null,
        completionLogic: 'all',
        completionThreshold: null,
        rewards: [],
        components: [
          {
            componentId: 100,
            componentCode: 'C1',
            componentName: 'component 1',
            activityName: 'Grocery Purchase',
            sequenceOrder: 0,
            isMandatory: true,
            completed: false,
          },
        ],
      },
    ],
  };
}

/** Waits for `useActivityTypeOptions`'s real fetch to resolve (the `Select` stays `disabled`
 * with a "Loading activity types…" placeholder until then) before interacting with it — a
 * plain `findByRole` only waits for the trigger to *exist*, not for it to become enabled. */
async function selectActivityType(name: RegExp | string) {
  const trigger = await screen.findByRole('combobox', { name: 'Activity type' });
  await waitFor(() => expect(trigger).not.toBeDisabled());
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1, pointerType: 'mouse' });
  fireEvent.click(trigger);

  const option = screen.getByRole('option', { name });
  fireEvent.pointerUp(option, { button: 0, pointerId: 1, pointerType: 'mouse' });
  fireEvent.click(option);
}

function renderPage(customer: Customer = PRIYA, queryClient = new QueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CustomerContext.Provider value={customerValue(customer)}>
          <ActivitySimulatorPage />
        </CustomerContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function activityResult(overrides: Partial<ActivityResult> = {}): ActivityResult {
  return {
    activityId: 'a1',
    customerId: 'priya-shah',
    activityType: 'Grocery Purchase',
    merchant: null,
    amount: null,
    matched: false,
    progress: [],
    rewards: [],
    ...overrides,
  };
}

describe('ActivitySimulatorPage', () => {
  beforeEach(() => {
    vi.spyOn(apiClient, 'getCampaigns').mockResolvedValue([SUMMER]);
    vi.spyOn(apiClient, 'getCampaign').mockResolvedValue(summerDetail());
    vi.spyOn(apiClient, 'getActivities').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Real pointerdown/click pairs against `@radix-ui/react-select` run through jsdom's own slow
  // pointer-capture retry loop (`CustomerSwitcher.test.tsx`'s own comment records the same real,
  // multi-second cost) — a longer-than-default timeout, not a flaky test.
  it('TC-1: a matched, non-completing activity updates the inline status, no toast', async () => {
    vi.spyOn(apiClient, 'postActivity').mockResolvedValue(
      activityResult({
        matched: true,
        progress: [
          {
            campaignId: 1,
            campaignCode: 'SUMMER_CASHBACK_SPRINT',
            campaignName: 'Summer Cashback Sprint',
            trackerId: 10,
            trackerCode: 'SCS_TRACKER',
            trackerName: 'Grocery Streak',
            componentId: 100,
            completedCount: 4,
            threshold: 5,
            trackerCompleted: false,
          },
        ],
      }),
    );
    renderPage();

    await selectActivityType('Grocery Purchase');
    fireEvent.click(screen.getByRole('button', { name: /submit activity/i }));

    expect(await screen.findByText('Progress updated — see the feed below.')).toBeInTheDocument();
    expect(screen.queryByText('Reward earned!')).not.toBeInTheDocument();
  }, 20000);

  it('TC-5: an unmatched activity shows a real "no progress" message, not a silent failure', async () => {
    vi.spyOn(apiClient, 'postActivity').mockResolvedValue(activityResult({ matched: false }));
    renderPage();

    await selectActivityType('Grocery Purchase');
    fireEvent.click(screen.getByRole('button', { name: /submit activity/i }));

    expect(
      await screen.findByText('No tracker matched this activity — no progress recorded.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Reward earned!')).not.toBeInTheDocument();
  }, 20000);

  it('TC-2/TC-3: a reward-earned SSE event for this customer shows the toast with a working /rewards link', async () => {
    renderPage();
    await screen.findByRole('combobox', { name: 'Activity type' });

    act(() => {
      sseBus.dispatchEvent(
        new CustomEvent('reward-earned', {
          detail: {
            id: 'r1',
            customerId: 'priya-shah',
            campaignId: 1,
            campaignCode: 'SUMMER_CASHBACK_SPRINT',
            type: 'cashback',
            value: '20',
            currency: 'USD',
            status: 'unused',
            issuedAt: '2026-06-01T00:00:00.000Z',
            expiresAt: null,
          },
        }),
      );
    });

    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('Reward earned!');
    expect(toast).toHaveTextContent('Summer Cashback Sprint');
    expect(screen.getByRole('link', { name: /view in my rewards/i })).toHaveAttribute(
      'href',
      '/rewards',
    );
  });

  it('ignores a reward-earned event for a different customer', async () => {
    renderPage();
    await screen.findByRole('combobox', { name: 'Activity type' });

    act(() => {
      sseBus.dispatchEvent(
        new CustomEvent('reward-earned', {
          detail: {
            id: 'r1',
            customerId: 'marcus-tan',
            campaignId: 1,
            campaignCode: 'SUMMER_CASHBACK_SPRINT',
            type: 'cashback',
            value: '20',
            currency: 'USD',
            status: 'unused',
            issuedAt: '2026-06-01T00:00:00.000Z',
            expiresAt: null,
          },
        }),
      );
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('TC-4: switching customers refetches that customer’s own feed and clears any prior toast', async () => {
    const getActivities = vi.spyOn(apiClient, 'getActivities').mockResolvedValue([]);
    const queryClient = new QueryClient();
    const { rerender } = renderPage(PRIYA, queryClient);
    await screen.findByRole('combobox', { name: 'Activity type' });

    act(() => {
      sseBus.dispatchEvent(
        new CustomEvent('reward-earned', {
          detail: {
            id: 'r1',
            customerId: 'priya-shah',
            campaignId: 1,
            campaignCode: 'SUMMER_CASHBACK_SPRINT',
            type: 'cashback',
            value: '20',
            currency: 'USD',
            status: 'unused',
            issuedAt: '2026-06-01T00:00:00.000Z',
            expiresAt: null,
          },
        }),
      );
    });
    await screen.findByRole('status');

    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <CustomerContext.Provider value={customerValue(MARCUS)}>
            <ActivitySimulatorPage />
          </CustomerContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(getActivities).toHaveBeenCalledWith('marcus-tan'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('TC-8: the submit button disables while the request is in flight, preventing a double POST', async () => {
    const postActivity = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.spyOn(apiClient, 'postActivity').mockImplementation(postActivity);
    renderPage();

    await selectActivityType('Grocery Purchase');
    const submit = screen.getByRole('button', { name: /submit activity/i });

    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByRole('button', { name: /submitting/i })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /submitting/i }));

    expect(postActivity).toHaveBeenCalledTimes(1);
  }, 20000);

  // A real defect found live-verifying this task: two `click()`s dispatched in the exact same
  // synchronous tick both reach `handleSubmit` while `postActivity.isPending`/the button's own
  // `disabled` attribute still reflect the *previous* render — neither has had a chance to update
  // yet, so relying on either alone let two real POSTs through (confirmed live: a customer's
  // tracker progressed by 2 from one same-tick double click, not 1). Fixed with a plain `useRef`
  // flag mutated synchronously in `handleSubmit`, independent of when React/React Query happen to
  // schedule their own re-render.
  it('TC-8 regression: a same-tick double click (no render between the two) still only posts once', async () => {
    const postActivity = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.spyOn(apiClient, 'postActivity').mockImplementation(postActivity);
    renderPage();

    await selectActivityType('Grocery Purchase');
    const submit = screen.getByRole('button', { name: /submit activity/i });

    // Both dispatched before React has any chance to re-render/disable the button in between —
    // this is what the earlier, `waitFor`-separated TC-8 test above does not cover.
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(postActivity).toHaveBeenCalled());
    // Give any errant second call a real chance to land before asserting it never does.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(postActivity).toHaveBeenCalledTimes(1);
  }, 20000);
});
