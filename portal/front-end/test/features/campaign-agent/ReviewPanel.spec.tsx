/**
 * T-049 — `ReviewPanel`: TC-6 (a complete summary before any write), TC-8 (the approval step is
 * stated), TC-9 ("Change something") and TC-17's focus move.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewPanel } from '../../../src/features/campaign-agent/ReviewPanel';
import type { AgentFailure } from '../../../src/features/campaign-agent/useAgentSession';
import { plan } from './fixtures';

afterEach(() => {
  cleanup();
});

function renderPanel(overrides: { failure?: AgentFailure | null; busy?: boolean } = {}) {
  const onConfirm = vi.fn();
  const onKeepEditing = vi.fn();
  render(
    <ReviewPanel
      plan={plan()}
      busy={overrides.busy ?? false}
      failure={overrides.failure ?? null}
      onConfirm={onConfirm}
      onKeepEditing={onKeepEditing}
    />,
  );
  return { onConfirm, onKeepEditing };
}

describe('TC-6 — the whole campaign is summarised before anything is created', () => {
  it('shows the basics, the merchants, the journey, the rule values and the reward', () => {
    renderPanel();

    expect(screen.getByText('Weekend Electronics Cashback')).toBeInTheDocument();
    expect(screen.getByText('RAYA-2026')).toBeInTheDocument();
    expect(screen.getByText('Instant reward')).toBeInTheDocument();
    expect(screen.getByText('Acme Electronics, TechWorld KL')).toBeInTheDocument();
    expect(screen.getByText('250000.00 MYR')).toBeInTheDocument();
    expect(screen.getByText('Weekend spend · all_of')).toBeInTheDocument();
    expect(screen.getByText('Purchase')).toBeInTheDocument();
    expect(screen.getByText(/minSpend 150, period weekly/)).toBeInTheDocument();
    expect(screen.getByText(/CASHBACK_INSTANT — paid at campaign level/)).toBeInTheDocument();
  });

  it('shows the rule version number, matching the wizard’s own picker', () => {
    renderPanel();
    expect(screen.getByText('v3')).toBeInTheDocument();
  });

  it('says "No budget set" rather than an empty row when there is no budget', () => {
    render(
      <ReviewPanel
        plan={plan({
          campaign: { ...plan().campaign, budgetAmount: null, budgetCurrency: null },
        })}
        busy={false}
        failure={null}
        onConfirm={vi.fn()}
        onKeepEditing={vi.fn()}
      />,
    );

    expect(screen.getByText('No budget set')).toBeInTheDocument();
  });
});

describe('the shapes a plan can take', () => {
  it('renders caps, an n-of tracker and a component-level reward', () => {
    render(
      <ReviewPanel
        plan={plan({
          tracker: { name: 'Weekend spend', completionLogic: 'n_of', completionThreshold: 1 },
          rewards: [
            {
              level: 'component',
              componentIndex: 0,
              rewardPolicyId: 4,
              policyName: 'CASHBACK_INSTANT',
            },
          ],
          caps: [
            {
              capClass: 'budget',
              scopeLevel: 'campaign',
              periodType: 'lifetime',
              maxTotalAmount: '50000.00',
              unitCode: 'MYR',
            },
            {
              capClass: 'limit',
              scopeLevel: 'campaign',
              periodType: 'daily',
              maxTotalAmount: null,
              maxOccurrences: 3,
            },
          ],
        })}
        busy={false}
        failure={null}
        onConfirm={vi.fn()}
        onKeepEditing={vi.fn()}
      />,
    );

    expect(screen.getByText('Weekend spend · any 1 of 1')).toBeInTheDocument();
    expect(
      screen.getByText('CASHBACK_INSTANT — paid at component level (Purchase)'),
    ).toBeInTheDocument();
    expect(screen.getByText('budget · campaign · lifetime · 50000.00 MYR')).toBeInTheDocument();
    expect(screen.getByText('limit · campaign · daily · 3 times')).toBeInTheDocument();
  });

  it('falls back to the rule code and to the raw date when either is all it has', () => {
    render(
      <ReviewPanel
        plan={plan({
          campaign: { ...plan().campaign, startDate: 'not-a-date' },
          components: [
            {
              name: 'Purchase',
              activityId: 5,
              activityName: 'Purchase',
              rules: [
                {
                  ruleId: 7,
                  ruleCode: 'MIN_SPEND_TIER',
                  ruleName: '',
                  ruleVersionId: null,
                  ruleVersionNo: null,
                  values: { tiers: [{ from: 100 }] },
                },
              ],
            },
          ],
        })}
        busy={false}
        failure={null}
        onConfirm={vi.fn()}
        onKeepEditing={vi.fn()}
      />,
    );

    expect(screen.getByText(/not-a-date/)).toBeInTheDocument();
    expect(screen.getByText(/MIN_SPEND_TIER/)).toBeInTheDocument();
    // A structured value is shown as JSON rather than as `[object Object]`.
    expect(screen.getByText(/tiers \[\{"from":100\}\]/)).toBeInTheDocument();
  });

  it('shows no limits section when the plan has no caps', () => {
    render(
      <ReviewPanel
        plan={plan()}
        busy={false}
        failure={null}
        onConfirm={vi.fn()}
        onKeepEditing={vi.fn()}
      />,
    );

    expect(screen.queryByText('Limits and caps')).not.toBeInTheDocument();
  });
});

describe('TC-8 — the approval step is a separate, human act', () => {
  it('says so in the copy above the button', () => {
    renderPanel();

    expect(
      screen.getByText(/the assistant never submits a campaign for approval/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
  });
});

describe('the two actions', () => {
  it('"Create draft" confirms; nothing is created until it is clicked', async () => {
    const user = userEvent.setup();
    const { onConfirm, onKeepEditing } = renderPanel();

    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onKeepEditing).not.toHaveBeenCalled();
  });

  it('TC-9 — "Change something" goes back to the conversation without creating anything', async () => {
    const user = userEvent.setup();
    const { onConfirm, onKeepEditing } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'Change something' }));

    expect(onKeepEditing).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('both actions are unavailable while a confirmation is in flight', () => {
    renderPanel({ busy: true });

    expect(screen.getByRole('button', { name: 'Create draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Change something' })).toBeDisabled();
  });
});

describe('TC-12 — a refusal from the server is rendered where the maker is looking', () => {
  it('shows the server’s own message and the violation codes', () => {
    renderPanel({
      failure: {
        kind: 'policy',
        message:
          "This tenant's ceiling for one MYR campaign is 200000.00, and 250000.00 is above it.",
        codes: ['BUDGET_ABOVE_TENANT_CEILING'],
        retryable: false,
      },
    });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('ceiling for one MYR campaign is 200000.00');
    expect(alert).toHaveTextContent('budget above tenant ceiling');
  });
});

describe('TC-17 — focus moves to the panel when it appears', () => {
  it('the heading takes focus, so a screen reader is not left at the bottom of the stream', () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: 'Review before creating' })).toHaveFocus();
  });
});
