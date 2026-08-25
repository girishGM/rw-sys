import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DefinitionRequest } from '@reward-portal/shared';

const { mockMutateAsync, mockUseUpdateDefinitionRequestMutation } = vi.hoisted(() => ({
  mockMutateAsync: vi.fn(),
  mockUseUpdateDefinitionRequestMutation: vi.fn(),
}));

vi.mock('./api', () => ({
  useUpdateDefinitionRequestMutation: mockUseUpdateDefinitionRequestMutation,
}));

import { EditDefinitionRequestModal } from './EditDefinitionRequestModal';

const request: DefinitionRequest = {
  id: 1,
  requestType: 'new_rule',
  entityId: null,
  requestedBy: 1,
  requestingCountryId: 9,
  requestingTenantId: null,
  title: 'Weekend multiplier',
  description: 'We need a weekend multiplier rule.',
  businessJustification: null,
  desiredBy: null,
  priority: 'normal',
  status: 'submitted',
  reviewedBy: null,
  reviewedAt: null,
  reviewComment: null,
  fulfilledVersionId: null,
  fulfilledAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EditDefinitionRequestModal open onClose={onClose} request={request} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutateAsync.mockReset();
  mockUseUpdateDefinitionRequestMutation.mockReset();
  mockUseUpdateDefinitionRequestMutation.mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
});

describe('EditDefinitionRequestModal', () => {
  it('pre-fills the form from the request (TC-6)', () => {
    renderModal();
    expect(screen.getByLabelText(/^title$/i)).toHaveValue('Weekend multiplier');
  });

  it('saves the edited fields', async () => {
    mockMutateAsync.mockResolvedValue({ ...request, title: 'Weekend multiplier (revised)' });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal(onClose);

    await user.clear(screen.getByLabelText(/^title$/i));
    await user.type(screen.getByLabelText(/^title$/i), 'Weekend multiplier (revised)');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Weekend multiplier (revised)' }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('rejects a too-short title before calling the API', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.clear(screen.getByLabelText(/^title$/i));
    await user.type(screen.getByLabelText(/^title$/i), 'x');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });
});
