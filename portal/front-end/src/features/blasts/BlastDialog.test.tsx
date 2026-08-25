import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RuleVersion } from '@reward-portal/shared';
import { ApiError } from '../../lib/apiError';

const { mockUseCountriesQuery, mockUsePreviewBlastMutation, mockUseCreateBlastMutation } =
  vi.hoisted(() => ({
    mockUseCountriesQuery: vi.fn(),
    mockUsePreviewBlastMutation: vi.fn(),
    mockUseCreateBlastMutation: vi.fn(),
  }));

vi.mock('../countries/api', () => ({ useCountriesQuery: mockUseCountriesQuery }));
vi.mock('./api', () => ({
  usePreviewBlastMutation: mockUsePreviewBlastMutation,
  useCreateBlastMutation: mockUseCreateBlastMutation,
}));

import { BlastDialog } from './BlastDialog';

const version: RuleVersion = {
  id: 10,
  ruleId: 1,
  versionNo: 3,
  expression: 'amount >= :minSpend',
  parameters: { fields: [] },
  changeSummary: null,
  isBreaking: false,
  status: 'published',
  supersedesVersionId: 9,
  originRequestId: null,
  createdBy: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  publishedBy: 1,
  publishedAt: '2026-01-01T00:00:00.000Z',
  deprecatedAt: null,
  retiredAt: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  suggestedIsBreaking: null,
};

const breakingVersion: RuleVersion = { ...version, isBreaking: true };

const previewResponse = {
  entityType: 'rule' as const,
  entityId: 1,
  versionId: 10,
  versionNo: 3,
  isBreaking: false,
  countries: [
    {
      countryId: 2,
      countryCode: 'MY',
      countryName: 'Malaysia',
      currentVersionNo: 2,
      willReceiveVersionNo: 3,
      activeCampaignsOnCurrentVersion: 1,
      isBreaking: false,
    },
  ],
};

let mockPreviewMutateAsync: ReturnType<typeof vi.fn>;
let mockPreviewReset: ReturnType<typeof vi.fn>;
let mockCreateMutateAsync: ReturnType<typeof vi.fn>;

function setPreviewState(overrides: Record<string, unknown> = {}) {
  mockUsePreviewBlastMutation.mockReturnValue({
    mutateAsync: mockPreviewMutateAsync,
    data: undefined,
    isPending: false,
    reset: mockPreviewReset,
    ...overrides,
  });
}

function renderDialog(v: RuleVersion = version, onClose = vi.fn()) {
  return render(
    <BlastDialog
      open
      onClose={onClose}
      entityType="rule"
      entityId={1}
      entityLabel="MIN_SPEND_TIER"
      version={v}
    />,
  );
}

beforeEach(() => {
  mockUseCountriesQuery.mockReset();
  mockUsePreviewBlastMutation.mockReset();
  mockUseCreateBlastMutation.mockReset();
  mockPreviewMutateAsync = vi.fn();
  mockPreviewReset = vi.fn();
  mockCreateMutateAsync = vi.fn();

  mockUseCountriesQuery.mockReturnValue({
    data: { data: [{ id: 2, code: 'MY', name: 'Malaysia' }] },
    isLoading: false,
  });
  setPreviewState();
  mockUseCreateBlastMutation.mockReturnValue({
    mutateAsync: mockCreateMutateAsync,
    isPending: false,
  });
});

describe('BlastDialog', () => {
  it('implementation note 6: Confirm blast is disabled until a preview exists', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: /confirm blast/i })).toBeDisabled();
  });

  it('Preview is disabled with the "selected" scope until at least one country is chosen', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: /^preview$/i })).toBeDisabled();
  });

  it('Preview is enabled immediately under "All active countries" scope', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('radio', { name: /all active countries/i }));
    expect(screen.getByRole('button', { name: /^preview$/i })).not.toBeDisabled();
  });

  it('TC-19: clicking Preview calls previewBlast with the current scope/version and shows the impact table', async () => {
    mockPreviewMutateAsync.mockResolvedValue(previewResponse);
    setPreviewState({ data: previewResponse });
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('radio', { name: /all active countries/i }));
    await user.click(screen.getByRole('button', { name: /^preview$/i }));

    expect(mockPreviewMutateAsync).toHaveBeenCalledWith({
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'all_countries',
      countryIds: undefined,
    });
    expect(screen.getByText('Malaysia', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument(); // holds now
    expect(screen.getByText('v3')).toBeInTheDocument(); // will hold
  });

  it('a preview failure surfaces the ApiError message', async () => {
    mockPreviewMutateAsync.mockRejectedValue(
      new ApiError({ status: 422, code: 'VERSION_NOT_PUBLISHED', message: 'Not published.' }),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('radio', { name: /all active countries/i }));
    await user.click(screen.getByRole('button', { name: /^preview$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Not published.');
  });

  it('once previewed, Confirm blast is enabled for a non-breaking version', () => {
    setPreviewState({ data: previewResponse });
    renderDialog();
    expect(screen.getByRole('button', { name: /confirm blast/i })).not.toBeDisabled();
  });

  it('a breaking version requires the confirmation checkbox before Confirm blast enables', async () => {
    setPreviewState({ data: { ...previewResponse, isBreaking: true } });
    const user = userEvent.setup();
    renderDialog(breakingVersion);

    expect(screen.getByRole('button', { name: /confirm blast/i })).toBeDisabled();
    await user.click(
      screen.getByRole('checkbox', { name: /understand this is a breaking change/i }),
    );
    expect(screen.getByRole('button', { name: /confirm blast/i })).not.toBeDisabled();
  });

  it('TC-7: Confirm blast submits the create-blast request with the current selection and note', async () => {
    setPreviewState({ data: previewResponse });
    mockCreateMutateAsync.mockResolvedValue({});
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDialog(version, onClose);

    await user.type(screen.getByLabelText(/note \(optional\)/i), 'Weekend promo');
    await user.click(screen.getByRole('radio', { name: /all active countries/i }));
    await user.click(screen.getByRole('button', { name: /confirm blast/i }));

    expect(mockCreateMutateAsync).toHaveBeenCalledWith({
      entityType: 'rule',
      entityId: 1,
      versionId: 10,
      scope: 'all_countries',
      countryIds: undefined,
      note: 'Weekend promo',
      confirmBreaking: undefined,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('a blast failure surfaces the ApiError message and does not close the dialog', async () => {
    setPreviewState({ data: previewResponse });
    mockCreateMutateAsync.mockRejectedValue(
      new ApiError({ status: 403, code: 'PERM_DENIED', message: 'No.' }),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDialog(version, onClose);

    await user.click(screen.getByRole('radio', { name: /all active countries/i }));
    await user.click(screen.getByRole('button', { name: /confirm blast/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('switching scope resets an existing preview', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('radio', { name: /all active countries/i }));
    expect(mockPreviewReset).toHaveBeenCalled();
  });

  it('Cancel resets local state and closes without submitting', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDialog(version, onClose);

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onClose).toHaveBeenCalled();
    expect(mockCreateMutateAsync).not.toHaveBeenCalled();
  });
});
