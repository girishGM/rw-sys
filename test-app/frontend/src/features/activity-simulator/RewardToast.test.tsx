import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RewardToast } from './RewardToast';
import type { RewardLedgerEntry } from '../../types';

const REWARD: RewardLedgerEntry = {
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
};

describe('RewardToast', () => {
  it('TC-2: shows the real reward value/campaign and an accessible live announcement', () => {
    render(
      <MemoryRouter>
        <RewardToast reward={REWARD} campaignName="Summer Cashback Sprint" onClose={() => {}} />
      </MemoryRouter>,
    );

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Reward earned!');
    expect(status).toHaveTextContent('$20.00 cashback');
    expect(status).toHaveTextContent('Summer Cashback Sprint');
  });

  it('TC-3: links to /rewards', () => {
    render(
      <MemoryRouter>
        <RewardToast reward={REWARD} campaignName="Summer Cashback Sprint" onClose={() => {}} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /view in my rewards/i })).toHaveAttribute(
      'href',
      '/rewards',
    );
  });

  it('calls onClose when the dismiss button is clicked', () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <RewardToast reward={REWARD} campaignName="Summer Cashback Sprint" onClose={onClose} />
      </MemoryRouter>,
    );

    screen.getByRole('button', { name: 'Dismiss' }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
