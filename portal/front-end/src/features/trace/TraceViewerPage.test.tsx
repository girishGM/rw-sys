import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Bootstrap, TraceResponse } from '@reward-portal/shared';
import { BootstrapContext, type BootstrapContextValue } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';

const { mockFetchTrace } = vi.hoisted(() => ({ mockFetchTrace: vi.fn() }));

vi.mock('./api', () => ({
  fetchTrace: mockFetchTrace,
  traceQueryKey: (id: string) => ['trace', id],
}));

import { TraceViewerPage } from './TraceViewerPage';

const baseTrace: TraceResponse = {
  correlationId: '01J8F3K9QP2M7N',
  summary: {
    correlationId: '01J8F3K9QP2M7N',
    startedAt: '2026-08-14T09:12:33.339Z',
    durationMs: 142,
    actor: { userId: 42, role: 'maker', sessionId: 'sess-1' },
    scope: { countryId: 3, tenantId: 7, merchantId: null },
    route: 'POST /api/v1/campaigns/:id/submit',
    status: 200,
  },
  spans: [
    {
      name: 'jwt.verify',
      startedAtMs: 0.2,
      durationMs: 0.8,
      status: 'ok',
      spanId: 'a1',
      slow: false,
      attributes: null,
    },
  ],
  sources: {
    portalAuditLog: 'available',
    domainAudit: 'available',
    logStore: 'not_configured',
    configFetches: 'not_configured',
  },
  auditEvents: [
    {
      id: '1',
      eventType: 'login_succeeded',
      actorId: 42,
      actorRole: 'maker',
      targetType: null,
      targetId: null,
      countryId: 3,
      tenantId: 7,
      ipAddress: '10.0.0.4',
      detail: null,
      occurredAt: '2026-08-14T09:12:33.000Z',
    },
  ],
  domainAudit: [],
  configFetches: [],
  logLines: null,
  truncated: false,
};

function bootstrapValue(role: Bootstrap['user']['role']): BootstrapContextValue {
  return {
    user: { id: 1, displayName: 'Test User', role, locale: 'en', timezone: null },
    scope: { countryId: null, tenantId: null, merchantId: null },
    nav: [],
    permissions: {},
    widgets: [],
    messages: {},
    isLoading: false,
    isError: false,
    isUnauthorized: false,
    hasPermission: () => true,
    refetch: () => undefined,
  };
}

function renderPage(role: Bootstrap['user']['role'], correlationId = '01J8F3K9QP2M7N') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BootstrapContext.Provider value={bootstrapValue(role)}>
        <MemoryRouter initialEntries={[`/trace/${correlationId}`]}>
          <Routes>
            <Route path="/trace/:correlationId" element={<TraceViewerPage />} />
          </Routes>
        </MemoryRouter>
      </BootstrapContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockFetchTrace.mockReset();
});

describe('role gating', () => {
  it('renders Forbidden, and never calls fetchTrace, for a non-super_admin role', () => {
    renderPage('country_admin');
    expect(screen.getByText(/don't have access/i)).toBeInTheDocument();
    expect(mockFetchTrace).not.toHaveBeenCalled();
  });

  it.each(['tenant_admin', 'maker', 'checker', 'merchant'] as const)(
    '%s also sees Forbidden',
    (role) => {
      renderPage(role);
      expect(screen.getByText(/don't have access/i)).toBeInTheDocument();
    },
  );

  it('a super_admin does trigger the fetch', async () => {
    mockFetchTrace.mockReturnValue(new Promise(() => undefined)); // never resolves — loading state
    renderPage('super_admin');
    await waitFor(() => expect(mockFetchTrace).toHaveBeenCalledWith('01J8F3K9QP2M7N'));
  });
});

describe('loading state', () => {
  it('shows skeletons and no content while the request is in flight', () => {
    mockFetchTrace.mockReturnValue(new Promise(() => undefined));
    renderPage('super_admin');
    expect(screen.queryByText('Trace')).not.toBeInTheDocument();
  });
});

describe('error states', () => {
  it('shows a 404-specific message', async () => {
    mockFetchTrace.mockRejectedValue(
      new ApiError({ code: 'NOT_FOUND', message: 'not found', status: 404 }),
    );
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('No trace found for this id')).toBeInTheDocument());
  });

  it('shows a 400-specific message for a malformed id', async () => {
    mockFetchTrace.mockRejectedValue(
      new ApiError({ code: 'VALIDATION_FAILED', message: 'bad', status: 400 }),
    );
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('Not a valid correlation id')).toBeInTheDocument());
  });

  it('shows a 403-specific message', async () => {
    mockFetchTrace.mockRejectedValue(
      new ApiError({ code: 'PERM_DENIED', message: 'denied', status: 403 }),
    );
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('Not authorised')).toBeInTheDocument());
  });

  it('falls back to the server message for an ApiError status this screen has no special case for', async () => {
    // 503 is not in `useTrace`'s definitive-failure list, so react-query retries it twice with
    // its default backoff before surfacing the error — a real, if slow, path worth covering
    // rather than mocking around; the longer timeout accommodates that backoff.
    mockFetchTrace.mockRejectedValue(
      new ApiError({ code: 'SERVICE_UNAVAILABLE', message: 'try later', status: 503 }),
    );
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('Could not load this trace')).toBeInTheDocument(), {
      timeout: 10_000,
    });
    expect(screen.getByText('try later')).toBeInTheDocument();
  }, 15_000);

  it('shows a generic message for a non-ApiError failure', async () => {
    mockFetchTrace.mockRejectedValue(new Error('boom'));
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('Could not load this trace')).toBeInTheDocument(), {
      timeout: 10_000,
    });
    expect(screen.getByText('An unexpected error occurred.')).toBeInTheDocument();
  }, 15_000);

  it('offers a Retry button that re-issues the request', async () => {
    // 404 is one of the statuses this screen's own `retry` callback never retries automatically
    // (definitive failures — see `useTrace`), so the mock is exhausted deterministically after
    // exactly one call, and the button click below is the only thing that triggers a second one.
    mockFetchTrace.mockRejectedValueOnce(
      new ApiError({ code: 'NOT_FOUND', message: 'not found', status: 404 }),
    );
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument());
    expect(mockFetchTrace).toHaveBeenCalledTimes(1);

    mockFetchTrace.mockResolvedValueOnce(baseTrace);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Trace')).toBeInTheDocument());
    expect(mockFetchTrace).toHaveBeenCalledTimes(2);
  });
});

describe('a completed trace (TC-1)', () => {
  it('renders the summary, the sources, and the correlation id', async () => {
    mockFetchTrace.mockResolvedValue(baseTrace);
    renderPage('super_admin');

    await waitFor(() => expect(screen.getByText('Trace')).toBeInTheDocument());
    expect(screen.getByText('01J8F3K9QP2M7N')).toBeInTheDocument();
    expect(screen.getByText('POST /api/v1/campaigns/:id/submit')).toBeInTheDocument();
    expect(screen.getByText(/Portal audit log: available/)).toBeInTheDocument();
    expect(screen.getByText(/Log store: not configured/)).toBeInTheDocument();
  });

  it('shows a truncation notice only when truncated is true', async () => {
    mockFetchTrace.mockResolvedValue({ ...baseTrace, truncated: true });
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText(/Truncated at 5,000 rows/)).toBeInTheDocument());
  });

  it('does not show a truncation notice when truncated is false', async () => {
    mockFetchTrace.mockResolvedValue(baseTrace);
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('Trace')).toBeInTheDocument());
    expect(screen.queryByText(/Truncated at 5,000 rows/)).not.toBeInTheDocument();
  });
});

describe('TC-19 — no domain audit rows', () => {
  it('renders the empty state in the domain-audit tab rather than omitting the section', async () => {
    mockFetchTrace.mockResolvedValue(baseTrace); // domainAudit: []
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('Trace')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('tab', { name: /Campaign audit \(0\)/ }));
    await waitFor(() => expect(screen.getByText('No campaign audit rows')).toBeInTheDocument());
  });
});

describe('the audit-events tab', () => {
  it('renders a populated row with the actor and target text (default tab is timeline, so this exercises the click path)', async () => {
    mockFetchTrace.mockResolvedValue(baseTrace);
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('Trace')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('tab', { name: /Audit events \(1\)/ }));
    await waitFor(() => expect(screen.getByText('login_succeeded')).toBeInTheDocument());
    const row = screen.getByText('login_succeeded').closest('tr');
    expect(row).toHaveTextContent('maker');
    expect(row).toHaveTextContent('(#42)');
  });

  it('renders the empty state when there are no audit events', async () => {
    mockFetchTrace.mockResolvedValue({ ...baseTrace, auditEvents: [] });
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('Trace')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('tab', { name: /Audit events \(0\)/ }));
    await waitFor(() => expect(screen.getByText('No portal audit events')).toBeInTheDocument());
  });

  it('renders a target when one is present', async () => {
    mockFetchTrace.mockResolvedValue({
      ...baseTrace,
      auditEvents: [{ ...baseTrace.auditEvents[0], targetType: 'portal_user', targetId: '7' }],
    });
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('Trace')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('tab', { name: /Audit events \(1\)/ }));
    await waitFor(() => expect(screen.getByText('login_succeeded')).toBeInTheDocument());
    const row = screen.getByText('login_succeeded').closest('tr');
    expect(row).toHaveTextContent('portal_user');
    expect(row).toHaveTextContent('#7');
  });
});

describe('the domain-audit tab, populated', () => {
  it('renders a row with a working campaign link and an approval-request link', async () => {
    mockFetchTrace.mockResolvedValue({
      ...baseTrace,
      domainAudit: [
        {
          id: 202,
          tenantId: 7,
          campaignId: 8821,
          entityType: 'campaign_submit',
          entityId: null,
          action: 'submitted',
          fieldChanges: null,
          performedBy: 42,
          performedAt: '2026-08-14T09:12:33.100Z',
          approvalRequestId: 55,
          comment: null,
        },
      ],
    });
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('Trace')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('tab', { name: /Campaign audit \(1\)/ }));
    await waitFor(() => expect(screen.getByText('submitted')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Campaign #8821' })).toHaveAttribute(
      'href',
      '/campaigns/8821',
    );
    expect(screen.getByRole('link', { name: 'Approval #55' })).toHaveAttribute(
      'href',
      '/approvals/55',
    );
  });

  it('renders a dash rather than a link when there is no approval request', async () => {
    mockFetchTrace.mockResolvedValue({
      ...baseTrace,
      domainAudit: [
        {
          id: 202,
          tenantId: 7,
          campaignId: 8821,
          entityType: 'campaign_submit',
          entityId: null,
          action: 'created',
          fieldChanges: null,
          performedBy: 42,
          performedAt: '2026-08-14T09:12:33.100Z',
          approvalRequestId: null,
          comment: null,
        },
      ],
    });
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('Trace')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('tab', { name: /Campaign audit \(1\)/ }));
    await waitFor(() => expect(screen.getByText('created')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /Approval #/ })).not.toBeInTheDocument();
  });
});

describe('the raw-log-lines tab', () => {
  it('shows a "not configured" empty state when the log store has no adapter', async () => {
    mockFetchTrace.mockResolvedValue(baseTrace); // sources.logStore: 'not_configured'
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('Trace')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('tab', { name: 'Raw log lines' }));
    await waitFor(() => expect(screen.getByText('No log store is configured')).toBeInTheDocument());
  });

  it('shows an "unavailable" empty state when the log store is down (TC-5)', async () => {
    mockFetchTrace.mockResolvedValue({
      ...baseTrace,
      sources: { ...baseTrace.sources, logStore: 'unavailable' },
      logLines: null,
    });
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('Trace')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('tab', { name: 'Raw log lines' }));
    await waitFor(() =>
      expect(screen.getByText('The log store is unavailable right now')).toBeInTheDocument(),
    );
  });

  it('shows "no log lines" when the store is available but answered empty', async () => {
    mockFetchTrace.mockResolvedValue({
      ...baseTrace,
      sources: { ...baseTrace.sources, logStore: 'available' },
      logLines: [],
    });
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('Trace')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('tab', { name: 'Raw log lines' }));
    await waitFor(() => expect(screen.getByText('No log lines')).toBeInTheDocument());
  });

  it('renders the raw JSON lines when the store answered with data', async () => {
    mockFetchTrace.mockResolvedValue({
      ...baseTrace,
      sources: { ...baseTrace.sources, logStore: 'available' },
      logLines: [{ ts: '2026-08-14T09:12:33.481Z', msg: 'request completed' }],
    });
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('Trace')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('tab', { name: 'Raw log lines' }));
    await waitFor(() => expect(screen.getByText(/"msg":"request completed"/)).toBeInTheDocument());
  });
});

describe('summary grid — partial data', () => {
  it('renders a dash for actor and scope when the log line carried neither', async () => {
    mockFetchTrace.mockResolvedValue({
      ...baseTrace,
      summary: { ...baseTrace.summary, actor: null, scope: null },
    });
    renderPage('super_admin');
    await waitFor(() => expect(screen.getByText('Trace')).toBeInTheDocument());

    const actorTerm = screen.getByText('Actor');
    expect(actorTerm.nextElementSibling).toHaveTextContent('—');
    const scopeTerm = screen.getByText('Scope');
    expect(scopeTerm.nextElementSibling).toHaveTextContent('—');
  });
});

describe('summary degradation — no completion log line', () => {
  it('explains the gap rather than rendering a grid of dashes', async () => {
    mockFetchTrace.mockResolvedValue({
      ...baseTrace,
      summary: {
        correlationId: '01J8F3K9QP2M7N',
        startedAt: null,
        durationMs: null,
        actor: null,
        scope: null,
        route: null,
        status: null,
      },
      spans: [],
    });
    renderPage('super_admin');
    await waitFor(() =>
      expect(screen.getByText(/No request-completion log line was found/)).toBeInTheDocument(),
    );
  });
});
