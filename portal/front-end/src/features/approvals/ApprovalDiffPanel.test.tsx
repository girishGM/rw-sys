/**
 * T-038 — the diff panel on its own, driven straight from `ApprovalDiff` values.
 *
 * Rendering it directly rather than through the detail screen is deliberate: this component's
 * whole contract is *"every shape of `ApprovalDiff` renders something readable"*, and the cheapest
 * honest way to assert that is to hand it each shape. The detail-page suite covers how it is
 * reached; this covers what it does once it is.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ApprovalBudgetLine, ApprovalDiff } from '@reward-portal/shared';
import { ApprovalDiffPanel } from './ApprovalDiffPanel';

function diff(overrides: Partial<ApprovalDiff> = {}): ApprovalDiff {
  return {
    renderable: true,
    problem: null,
    changed: [],
    unchangedCount: 0,
    skippedFields: [],
    budgets: [],
    warnings: [],
    trackerCount: null,
    componentCount: null,
    ...overrides,
  };
}

function budget(overrides: Partial<ApprovalBudgetLine> = {}): ApprovalBudgetLine {
  return {
    unitType: 'currency',
    unitCode: 'MYR',
    campaignBudget: '100000.00',
    maxCampaignBudget: '500000.00',
    percentOfCeiling: 20,
    state: 'ok',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe('T-038 · ApprovalDiffPanel — the comparison', () => {
  it('counts the unchanged fields rather than listing them', () => {
    render(<ApprovalDiffPanel diff={diff({ unchangedCount: 4 })} />);

    expect(screen.getByText(/4 fields compared/)).toBeInTheDocument();
  });

  it('uses the singular for one compared field', () => {
    render(<ApprovalDiffPanel diff={diff({ unchangedCount: 1 })} />);

    expect(screen.getByText(/1 field compared/)).toBeInTheDocument();
  });

  it('says nothing changed, full stop, when there was nothing comparable either', () => {
    render(<ApprovalDiffPanel diff={diff({ unchangedCount: 0 })} />);

    expect(screen.getByText(/Nothing has changed since this was submitted\./)).toBeInTheDocument();
  });

  it('renders a null before/after as an em dash rather than as the word "null"', () => {
    render(
      <ApprovalDiffPanel
        diff={diff({
          changed: [{ field: 'name', label: 'Name', before: null, after: null }],
        })}
      />,
    );

    const table = screen.getByRole('table', { name: /fields changed since submission/i });
    expect(within(table).getAllByText('—')).toHaveLength(2);
  });
});

describe('T-038 · ApprovalDiffPanel — the submission context', () => {
  it.each([
    ['ok', '20%'],
    ['warn', '20%'],
    ['over', '20%'],
  ])('renders a %s budget line with its share of the ceiling', (state, label) => {
    render(<ApprovalDiffPanel diff={diff({ budgets: [budget({ state })] })} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText('MYR')).toBeInTheDocument();
  });

  it('falls back to the state when no percentage could be computed — a tenant with no ceiling', () => {
    render(
      <ApprovalDiffPanel
        diff={diff({
          budgets: [
            budget({ percentOfCeiling: null, maxCampaignBudget: null, state: 'unbounded' }),
          ],
        })}
      />,
    );

    expect(screen.getByText('unbounded')).toBeInTheDocument();
    // No ceiling to compare against, shown as an em dash rather than as a zero.
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('lists the warnings the maker was shown at submission', () => {
    render(<ApprovalDiffPanel diff={diff({ warnings: ['UNBUDGETED_REWARD_UNIT'] })} />);

    expect(screen.getByText('UNBUDGETED_REWARD_UNIT')).toBeInTheDocument();
  });

  it('summarises the journey size, with em dashes for the halves it does not know', () => {
    render(<ApprovalDiffPanel diff={diff({ trackerCount: 2, componentCount: null })} />);

    expect(
      screen.getByText(/Journey as submitted: 2 tracker\(s\), — component\(s\)\./),
    ).toBeInTheDocument();
  });

  it('omits the journey summary entirely when neither count is known', () => {
    render(<ApprovalDiffPanel diff={diff()} />);

    expect(screen.queryByText(/Journey as submitted/)).not.toBeInTheDocument();
  });
});

describe('T-038 TC-20 · ApprovalDiffPanel — every unrenderable shape', () => {
  it.each([
    ['PAYLOAD_MISSING', /nothing was recorded/i],
    ['PAYLOAD_NOT_AN_OBJECT', /not in a shape this screen can compare/i],
    ['SUBJECT_UNAVAILABLE', /no longer available to you/i],
  ] as const)('names the problem for %s', (problem, copy) => {
    render(<ApprovalDiffPanel diff={diff({ renderable: false, problem })} />);

    expect(screen.getByText('Cannot show a comparison')).toBeInTheDocument();
    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it('still says something useful for an unrenderable diff with no problem named at all', () => {
    // Not reachable from today's server, which always names a problem when `renderable` is false.
    // It is asserted anyway because this component's contract is that *no* `ApprovalDiff` renders
    // a blank panel — the failure mode TC-20 exists to prevent.
    render(<ApprovalDiffPanel diff={diff({ renderable: false, problem: null })} />);

    expect(screen.getByText('Cannot show a comparison')).toBeInTheDocument();
    expect(screen.getByText(/nothing was recorded/i)).toBeInTheDocument();
  });

  it('still shows the payload context it could extract alongside the problem', () => {
    render(
      <ApprovalDiffPanel
        diff={diff({
          renderable: false,
          problem: 'SUBJECT_UNAVAILABLE',
          budgets: [budget()],
          trackerCount: 1,
          componentCount: 3,
        })}
      />,
    );

    expect(screen.getByText('Cannot show a comparison')).toBeInTheDocument();
    // The request row is still governance evidence; what survived is still shown.
    expect(screen.getByText('20%')).toBeInTheDocument();
    expect(screen.getByText(/1 tracker\(s\), 3 component\(s\)/)).toBeInTheDocument();
  });
});
