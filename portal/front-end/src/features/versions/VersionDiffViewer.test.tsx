import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RuleVersion } from '@reward-portal/shared';

const { mockUseVersionDiffQuery } = vi.hoisted(() => ({ mockUseVersionDiffQuery: vi.fn() }));

vi.mock('./api', () => ({ useVersionDiffQuery: mockUseVersionDiffQuery }));

import { VersionDiffViewer } from './VersionDiffViewer';

function version(overrides: Partial<RuleVersion>): RuleVersion {
  return {
    id: 10,
    ruleId: 1,
    versionNo: 2,
    expression: null,
    parameters: {},
    changeSummary: null,
    isBreaking: false,
    status: 'published',
    supersedesVersionId: null,
    originRequestId: null,
    createdBy: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    publishedBy: 1,
    publishedAt: '2026-01-01T00:00:00.000Z',
    deprecatedAt: null,
    retiredAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    suggestedIsBreaking: null,
    ...overrides,
  };
}

const versions = [
  version({ id: 10, versionNo: 2, status: 'published' }),
  version({ id: 11, versionNo: 3, status: 'draft' }),
];

beforeEach(() => {
  mockUseVersionDiffQuery.mockReset();
  mockUseVersionDiffQuery.mockReturnValue({ isLoading: false, data: undefined });
});

describe('VersionDiffViewer', () => {
  it('offers every version, labelled with its number and status, in both pickers', () => {
    render(<VersionDiffViewer entityType="rule" entityId={1} versions={versions} />);
    expect(screen.getByRole('combobox', { name: /^compare$/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /^against$/i })).toBeInTheDocument();
  });

  it('shows a skeleton while the diff is loading', () => {
    mockUseVersionDiffQuery.mockReturnValue({ isLoading: true, data: undefined });
    const { container } = render(
      <VersionDiffViewer entityType="rule" entityId={1} versions={versions} />,
    );
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('TC-25: renders added/removed/type-changed parameters once both versions are picked', async () => {
    mockUseVersionDiffQuery.mockReturnValue({
      isLoading: false,
      data: {
        versionId: 10,
        otherVersionId: 11,
        versionNo: 2,
        otherVersionNo: 3,
        expressionChanged: true,
        parametersAdded: ['newField'],
        parametersRemoved: ['minSpend'],
        parametersTypeChanged: ['tier'],
        suggestedIsBreaking: true,
      },
    });
    const user = userEvent.setup();
    render(<VersionDiffViewer entityType="rule" entityId={1} versions={versions} />);

    await user.click(screen.getByRole('combobox', { name: /^compare$/i }));
    await user.click(screen.getByRole('option', { name: 'v2 (published)' }));
    await user.click(screen.getByRole('combobox', { name: /^against$/i }));
    await user.click(screen.getByRole('option', { name: 'v3 (draft)' }));

    expect(screen.getByText('+ newField')).toBeInTheDocument();
    expect(screen.getByText('− minSpend')).toBeInTheDocument();
    expect(screen.getByText('~ tier')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument(); // expressionChanged
    expect(screen.getByText('true')).toBeInTheDocument(); // suggestedIsBreaking
  });

  it('renders "—" placeholders when nothing changed in a category', () => {
    mockUseVersionDiffQuery.mockReturnValue({
      isLoading: false,
      data: {
        versionId: 10,
        otherVersionId: 11,
        versionNo: 2,
        otherVersionNo: 3,
        expressionChanged: false,
        parametersAdded: [],
        parametersRemoved: [],
        parametersTypeChanged: [],
        suggestedIsBreaking: false,
      },
    });
    render(<VersionDiffViewer entityType="rule" entityId={1} versions={versions} />);

    expect(screen.getAllByText('—')).toHaveLength(3);
    expect(screen.getByText('No')).toBeInTheDocument();
    expect(screen.getByText('false')).toBeInTheDocument();
  });
});
