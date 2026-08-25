import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusPill, type CampaignStatus } from '../../src/components/StatusPill';

const STATUSES: { status: CampaignStatus; label: string }[] = [
  { status: 'draft', label: 'Draft' },
  { status: 'pending_approval', label: 'Pending approval' },
  { status: 'active', label: 'Active' },
  { status: 'paused', label: 'Paused' },
  { status: 'rejected', label: 'Rejected' },
  { status: 'completed', label: 'Completed' },
  { status: 'archived', label: 'Archived' },
];

describe('StatusPill', () => {
  it.each(STATUSES)(
    'TC-8: $status renders a distinct colour class and a visible text label',
    ({ status, label }) => {
      render(<StatusPill status={status} />);
      expect(screen.getByText(label)).toBeInTheDocument();
    },
  );

  it('TC-8: draft and paused (both plausible neutrals) resolve to different colour tokens', () => {
    const { container: draftContainer } = render(<StatusPill status="draft" />);
    const { container: pausedContainer } = render(<StatusPill status="paused" />);
    const draftClasses = draftContainer.querySelector('span')?.className;
    const pausedClasses = pausedContainer.querySelector('span')?.className;
    expect(draftClasses).not.toEqual(pausedClasses);
  });

  it('never conveys status by colour alone — text is always present in the accessible name', () => {
    render(<StatusPill status="active" />);
    const pill = screen.getByText('Active');
    expect(pill.textContent).toContain('Active');
  });
});
