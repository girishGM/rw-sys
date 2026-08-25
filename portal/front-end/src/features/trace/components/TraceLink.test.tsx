import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApprovalRequestLink, CampaignLink, TraceLink } from './TraceLink';
import { approvalRequestPath, campaignPath, traceViewerPath } from './trace-links';

function withRouter(node: ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe('path builders', () => {
  it('traceViewerPath percent-encodes the id', () => {
    expect(traceViewerPath('01J8F3K9QP2M7N')).toBe('/trace/01J8F3K9QP2M7N');
    expect(traceViewerPath('has a space')).toBe('/trace/has%20a%20space');
  });

  it('campaignPath / approvalRequestPath match router.tsx’s existing routes', () => {
    expect(campaignPath(8821)).toBe('/campaigns/8821');
    expect(approvalRequestPath(55)).toBe('/approvals/55');
  });
});

describe('TraceLink — the inbound cross-link (implementation note 7)', () => {
  it('renders a link to the trace viewer when a correlation id is present', () => {
    withRouter(<TraceLink correlationId="01J8F3K9QP2M7N" />);
    const link = screen.getByRole('link', { name: '01J8F3K9QP2M7N' });
    expect(link).toHaveAttribute('href', '/trace/01J8F3K9QP2M7N');
  });

  it('renders custom children instead of the bare id when given', () => {
    withRouter(<TraceLink correlationId="01J8F3K9QP2M7N">View trace</TraceLink>);
    expect(screen.getByRole('link', { name: 'View trace' })).toBeInTheDocument();
  });

  it('renders plain text — not a link — when there is no correlation id', () => {
    withRouter(<TraceLink correlationId={null} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders plain text for undefined and the empty string too', () => {
    withRouter(<TraceLink correlationId={undefined} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    withRouter(<TraceLink correlationId="" />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});

describe('CampaignLink / ApprovalRequestLink — the outbound cross-links', () => {
  it('CampaignLink points at /campaigns/:id', () => {
    withRouter(<CampaignLink campaignId={8821} />);
    expect(screen.getByRole('link', { name: 'Campaign #8821' })).toHaveAttribute(
      'href',
      '/campaigns/8821',
    );
  });

  it('ApprovalRequestLink points at /approvals/:id', () => {
    withRouter(<ApprovalRequestLink approvalRequestId={55} />);
    expect(screen.getByRole('link', { name: 'Approval #55' })).toHaveAttribute(
      'href',
      '/approvals/55',
    );
  });
});
