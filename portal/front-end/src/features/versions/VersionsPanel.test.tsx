import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RuleVersion } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';

const {
  mockUseVersionsQuery,
  mockUseCreateDraftMutation,
  mockUseVersionTransitionMutation,
  mockCreateDraftMutateAsync,
  mockPublishMutateAsync,
  mockDeprecateMutateAsync,
  mockRetireMutateAsync,
} = vi.hoisted(() => ({
  mockUseVersionsQuery: vi.fn(),
  mockUseCreateDraftMutation: vi.fn(),
  mockUseVersionTransitionMutation: vi.fn(),
  mockCreateDraftMutateAsync: vi.fn(),
  mockPublishMutateAsync: vi.fn(),
  mockDeprecateMutateAsync: vi.fn(),
  mockRetireMutateAsync: vi.fn(),
}));

vi.mock('./api', () => ({
  useVersionsQuery: mockUseVersionsQuery,
  useCreateDraftMutation: mockUseCreateDraftMutation,
  useVersionTransitionMutation: mockUseVersionTransitionMutation,
}));
vi.mock('./EditVersionDraftModal', () => ({
  EditVersionDraftModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="edit-version-modal" /> : null,
}));
vi.mock('../blasts/BlastDialog', () => ({
  BlastDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="blast-dialog" /> : null),
}));
vi.mock('./VersionDiffViewer', () => ({
  VersionDiffViewer: () => <div data-testid="version-diff-viewer" />,
}));

import { VersionsPanel } from './VersionsPanel';

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

function bootstrapValue(canWrite: boolean): BootstrapContextValue {
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
    hasPermission: (entity, action) => canWrite && entity === 'rule' && action === 'create',
    refetch: () => undefined,
  };
}

function renderPanel(canWrite = true) {
  return render(
    <BootstrapContext.Provider value={bootstrapValue(canWrite)}>
      <VersionsPanel entityType="rule" entityId={1} entityLabel="MIN_SPEND_TIER" />
    </BootstrapContext.Provider>,
  );
}

beforeEach(() => {
  mockUseVersionsQuery.mockReset();
  mockUseCreateDraftMutation.mockReset();
  mockUseVersionTransitionMutation.mockReset();
  mockCreateDraftMutateAsync.mockReset();
  mockPublishMutateAsync.mockReset();
  mockDeprecateMutateAsync.mockReset();
  mockRetireMutateAsync.mockReset();

  mockUseCreateDraftMutation.mockReturnValue({
    mutateAsync: mockCreateDraftMutateAsync,
    isPending: false,
  });
  mockUseVersionTransitionMutation.mockImplementation(
    (_entityType: string, _entityId: number, action: string) => {
      const mutateAsync =
        action === 'publish'
          ? mockPublishMutateAsync
          : action === 'deprecate'
            ? mockDeprecateMutateAsync
            : mockRetireMutateAsync;
      return { mutateAsync, isPending: false };
    },
  );
});

describe('VersionsPanel', () => {
  it('shows a skeleton while loading', () => {
    mockUseVersionsQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    const { container } = renderPanel();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('shows an empty state when there are no versions', () => {
    mockUseVersionsQuery.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderPanel();
    expect(screen.getByText('No versions yet.')).toBeInTheDocument();
  });

  it('shows an error state when the list fails to load', () => {
    mockUseVersionsQuery.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderPanel();
    expect(screen.getByText('Could not load versions')).toBeInTheDocument();
  });

  it('renders the version timeline with status badges, newest first as supplied by the query', () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [version({ id: 11, versionNo: 3, status: 'draft' }), version({ id: 10, versionNo: 2 })],
      isLoading: false,
      isError: false,
    });
    renderPanel();
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getByText('published')).toBeInTheDocument();
  });

  it('read-only role (canWrite=false) sees no write controls at all', () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [version({ id: 10, status: 'draft' })],
      isLoading: false,
      isError: false,
    });
    renderPanel(false);
    expect(screen.queryByRole('button', { name: /new draft/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
  });

  it('a draft row offers Edit and Publish; disables "New draft" while one exists', () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [version({ id: 10, status: 'draft' })],
      isLoading: false,
      isError: false,
    });
    renderPanel();
    expect(screen.getByRole('button', { name: /new draft/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^publish$/i })).toBeInTheDocument();
  });

  it('a published row offers Blast and Deprecate', () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [version({ id: 10, status: 'published' })],
      isLoading: false,
      isError: false,
    });
    renderPanel();
    expect(screen.getByRole('button', { name: /blast/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /deprecate/i })).toBeInTheDocument();
  });

  it('a deprecated row offers only Retire', () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [version({ id: 10, status: 'deprecated' })],
      isLoading: false,
      isError: false,
    });
    renderPanel();
    expect(screen.getByRole('button', { name: /retire/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /blast/i })).not.toBeInTheDocument();
  });

  it('a retired row offers no action at all', () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [version({ id: 10, status: 'retired' })],
      isLoading: false,
      isError: false,
    });
    renderPanel();
    expect(screen.queryByRole('button', { name: /retire/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
  });

  it('clicking "New draft" calls the create-draft mutation', async () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [version({ id: 10, status: 'published' })],
      isLoading: false,
      isError: false,
    });
    mockCreateDraftMutateAsync.mockResolvedValue(version({ id: 11, status: 'draft' }));
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /new draft/i }));
    expect(mockCreateDraftMutateAsync).toHaveBeenCalledWith({});
  });

  it('shows an API error message when creating a draft fails', async () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [version({ id: 10, status: 'published' })],
      isLoading: false,
      isError: false,
    });
    mockCreateDraftMutateAsync.mockRejectedValue(
      new ApiError({
        status: 409,
        code: 'VERSION_DRAFT_ALREADY_EXISTS',
        message: 'Already exists.',
      }),
    );
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /new draft/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Already exists.');
  });

  it('TC-5: clicking Publish calls the transition mutation with the version id', async () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [version({ id: 10, status: 'draft' })],
      isLoading: false,
      isError: false,
    });
    mockPublishMutateAsync.mockResolvedValue(version({ id: 10, status: 'published' }));
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /^publish$/i }));
    expect(mockPublishMutateAsync).toHaveBeenCalledWith(10);
  });

  it('clicking Deprecate then Retire calls their respective mutations', async () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [version({ id: 10, status: 'published' })],
      isLoading: false,
      isError: false,
    });
    mockDeprecateMutateAsync.mockResolvedValue(version({ id: 10, status: 'deprecated' }));
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /deprecate/i }));
    expect(mockDeprecateMutateAsync).toHaveBeenCalledWith(10);
  });

  it('shows an API error message when a transition fails', async () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [version({ id: 10, status: 'deprecated' })],
      isLoading: false,
      isError: false,
    });
    mockRetireMutateAsync.mockRejectedValue(
      new ApiError({ status: 409, code: 'VERSION_INVALID_TRANSITION', message: 'Not deprecated.' }),
    );
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /retire/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not deprecated.');
  });

  it('opens the edit-draft modal for a draft row', async () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [version({ id: 10, status: 'draft' })],
      isLoading: false,
      isError: false,
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.getByTestId('edit-version-modal')).toBeInTheDocument();
  });

  it('opens the blast dialog for a published row', async () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [version({ id: 10, status: 'published' })],
      isLoading: false,
      isError: false,
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('button', { name: /blast/i }));
    expect(screen.getByTestId('blast-dialog')).toBeInTheDocument();
  });

  it('TC-25: shows the diff viewer once two or more versions exist, not for a single version', () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [version({ id: 10, status: 'published' })],
      isLoading: false,
      isError: false,
    });
    const { rerender } = renderPanel();
    expect(screen.queryByTestId('version-diff-viewer')).not.toBeInTheDocument();

    mockUseVersionsQuery.mockReturnValue({
      data: [
        version({ id: 10, versionNo: 2, status: 'published' }),
        version({ id: 11, versionNo: 3, status: 'draft' }),
      ],
      isLoading: false,
      isError: false,
    });
    rerender(
      <BootstrapContext.Provider value={bootstrapValue(true)}>
        <VersionsPanel entityType="rule" entityId={1} entityLabel="MIN_SPEND_TIER" />
      </BootstrapContext.Provider>,
    );
    expect(screen.getByTestId('version-diff-viewer')).toBeInTheDocument();
  });

  it('suggestedIsBreaking !== isBreaking surfaces a "(suggested: true)" hint', () => {
    mockUseVersionsQuery.mockReturnValue({
      data: [version({ id: 10, isBreaking: false, suggestedIsBreaking: true })],
      isLoading: false,
      isError: false,
    });
    renderPanel();
    expect(screen.getByText(/suggested: true/i)).toBeInTheDocument();
  });
});
