/**
 * T-049 — `AgentChatPage` end to end against a mocked wire: TC-1, TC-2, TC-3, TC-5, TC-7, TC-8,
 * TC-9, TC-10, TC-11, TC-12, TC-15, TC-16, TC-19 and TC-22.
 *
 * The `api` module is mocked rather than the HTTP client, because what these cases are about is
 * the *screen's* behaviour given each server answer — `api.spec.ts` already covers the wire itself.
 * Every mocked answer is built from the shared contract types (`./fixtures`), so a screen that
 * passes here is a screen driven by the real shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockAbandon, mockBuildPlan, mockConfirm, mockList, mockResume, mockSend, mockStart } =
  vi.hoisted(() => ({
    mockAbandon: vi.fn(),
    mockBuildPlan: vi.fn(),
    mockConfirm: vi.fn(),
    mockList: vi.fn(),
    mockResume: vi.fn(),
    mockSend: vi.fn(),
    mockStart: vi.fn(),
  }));

vi.mock('../../../src/features/campaign-agent/api', () => ({
  AGENT_TIMEOUT_CODE: 'AGENT_TURN_TIMEOUT',
  AGENT_TURN_TIMEOUT_MS: 30_000,
  abandonAgentSession: mockAbandon,
  buildAgentPlan: mockBuildPlan,
  confirmAgentPlan: mockConfirm,
  listAgentSessions: mockList,
  resumeAgentSession: mockResume,
  sendAgentMessage: mockSend,
  startAgentSession: mockStart,
}));

import { AgentChatPage } from '../../../src/features/campaign-agent/AgentChatPage';
import { ApiError } from '../../../src/lib/apiError';
import {
  MERCHANT_OPTIONS,
  RULE_OPTIONS,
  SESSION_ID,
  created,
  detail,
  plan,
  progress,
  session,
  turn,
} from './fixtures';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/campaigns/assistant']}>
        <Routes>
          <Route path="/campaigns/assistant" element={<AgentChatPage />} />
          <Route path="/campaigns/new" element={<h1>Campaign wizard</h1>} />
          <Route path="/campaigns/:id" element={<h1>Campaign draft</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The common opening: no live session, so the page opens a new one and shows the greeting. */
function openWith(first = turn({ reply: 'What should this campaign do?' })) {
  mockList.mockResolvedValue([]);
  mockStart.mockResolvedValue(first);
}

/**
 * The transcript, as a query root.
 *
 * Assertions about what was *said* go through this rather than `screen`, because the progress
 * panel legitimately repeats the server's `nextStep` sentence — two elements with the same text is
 * correct behaviour here, not an ambiguity to work around.
 */
function stream() {
  return within(screen.getByRole('list', { name: 'Conversation with the assistant' }));
}

async function typeAndSend(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Your message'), text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
}

beforeEach(() => {
  for (const mock of [
    mockAbandon,
    mockBuildPlan,
    mockConfirm,
    mockList,
    mockResume,
    mockSend,
    mockStart,
  ]) {
    mock.mockReset();
  }
});

afterEach(() => {
  cleanup();
});

describe('opening the screen', () => {
  it('opens a new session and shows the greeting in a labelled conversation region', async () => {
    openWith(turn({ reply: 'I can set up a reward campaign with you.' }));
    renderPage();

    expect(await screen.findByText('I can set up a reward campaign with you.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Conversation' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Conversation' })).toBeInTheDocument();
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('TC-15 — reopening restores the conversation from the server instead of starting a new one', async () => {
    mockList.mockResolvedValue([session()]);
    mockResume.mockResolvedValue(detail());
    renderPage();

    expect(await screen.findByText('A weekend cashback campaign')).toBeInTheDocument();
    expect(screen.getByText('What should this campaign do?')).toBeInTheDocument();
    expect(mockResume).toHaveBeenCalledWith(SESSION_ID);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('resumes neither a created nor an abandoned session — those are terminal', async () => {
    mockList.mockResolvedValue([
      session({ state: 'created', campaignId: 42 }),
      session({ state: 'abandoned' }),
    ]);
    mockStart.mockResolvedValue(turn({ reply: 'Fresh start.' }));
    renderPage();

    expect(await screen.findByText('Fresh start.')).toBeInTheDocument();
    expect(mockResume).not.toHaveBeenCalled();
  });

  it('shows what is still to answer, using the server’s own progress block', async () => {
    openWith(
      turn({
        progress: progress({ missing: ['merchants', 'ruleValues'], nextStep: 'Which merchants?' }),
      }),
    );
    renderPage();

    const panel = await screen.findByRole('region', { name: 'Still to answer' });
    expect(within(panel).getByText('Which merchants?')).toBeInTheDocument();
    expect(within(panel).getByText('Participating merchants')).toBeInTheDocument();
    // TC-5 — the rule-values step is named by the server (`agent.state.ts#SLOT_STEPS`), and the
    // questions themselves are generated server-side from the rule version's parameter schema.
    expect(within(panel).getByText('Values for those rules')).toBeInTheDocument();
  });
});

describe('TC-1 — a full conversation ending in a draft', () => {
  it('walks message → chips → review → confirm → hand-off', async () => {
    const user = userEvent.setup();
    openWith(turn({ reply: 'What should this campaign do?' }));
    mockSend
      .mockResolvedValueOnce(
        turn({ reply: 'Which merchants take part?', options: MERCHANT_OPTIONS }),
      )
      .mockResolvedValueOnce(
        turn({
          reply: 'Everything is answered.',
          progress: progress({ missing: [], nextStep: 'Review it.', complete: true }),
        }),
      );
    mockBuildPlan.mockResolvedValue(
      turn({
        session: session({ state: 'reviewing', planHash: 'a'.repeat(64) }),
        reply: 'Here is the whole campaign.',
        plan: plan(),
        progress: progress({ missing: [], nextStep: 'Review it.', complete: true }),
      }),
    );
    mockConfirm.mockResolvedValue(created());

    renderPage();
    await screen.findByText('What should this campaign do?');

    await typeAndSend('A weekend cashback campaign');
    expect(await stream().findByText('Which merchants take part?')).toBeInTheDocument();
    expect(mockSend).toHaveBeenCalledWith(SESSION_ID, 'A weekend cashback campaign');

    // TC-2 — the chips are the maker's own tenant's merchants, exactly as the server sent them.
    await user.click(await screen.findByRole('button', { name: /Acme Electronics/ }));
    await user.click(screen.getByRole('button', { name: 'Use these merchants' }));
    expect(mockSend).toHaveBeenLastCalledWith(
      SESSION_ID,
      'I choose these merchants: Acme Electronics — ACME-EL (m_12)',
    );

    await user.click(await screen.findByRole('button', { name: 'Review the campaign' }));

    // TC-6 — the review panel, before anything is created.
    expect(
      await screen.findByRole('heading', { name: 'Review before creating' }),
    ).toBeInTheDocument();
    expect(mockConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Create draft' }));

    // TC-7 — the hand-off, with a working link into the wizard.
    expect(
      await screen.findByRole('heading', { name: /Created as draft RAYA-2026/ }),
    ).toBeInTheDocument();
    expect(mockConfirm).toHaveBeenCalledWith(SESSION_ID, 'a'.repeat(64));
    const link = screen.getByRole('link', { name: 'Open RAYA-2026 in the wizard' });
    expect(link).toHaveAttribute('href', '/campaigns/42');

    await user.click(link);
    expect(await screen.findByRole('heading', { name: 'Campaign draft' })).toBeInTheDocument();
  });

  it('TC-3 — rule chips show the version number the maker is choosing', async () => {
    openWith();
    mockSend.mockResolvedValue(turn({ reply: 'Two rules are available.', options: RULE_OPTIONS }));
    renderPage();
    await screen.findByText('What should this campaign do?');

    await typeAndSend('Use a spend rule');

    expect(await screen.findByText('MIN_SPEND_TIER · v3')).toBeInTheDocument();
    expect(screen.getByText('SPEND_TIER · v2')).toBeInTheDocument();
  });

  it('TC-4 — choosing a rule sends its optionId and its version, and the choice is in the transcript', async () => {
    const user = userEvent.setup();
    openWith();
    mockSend
      .mockResolvedValueOnce(turn({ reply: 'Two rules are available.', options: RULE_OPTIONS }))
      .mockResolvedValueOnce(turn({ reply: 'Recorded.' }));
    renderPage();
    await screen.findByText('What should this campaign do?');

    await typeAndSend('Which rules can I use?');
    await user.click(await screen.findByRole('button', { name: /Minimum spend tier/ }));

    expect(mockSend).toHaveBeenLastCalledWith(
      SESSION_ID,
      'I choose this rule: Minimum spend tier — MIN_SPEND_TIER · v3 (r_7)',
    );
    expect(
      await screen.findByText('I choose this rule: Minimum spend tier — MIN_SPEND_TIER · v3 (r_7)'),
    ).toBeInTheDocument();
  });

  it('TC-8 — the copy says the approval step is still the maker’s, before and after the draft exists', async () => {
    const user = userEvent.setup();
    openWith(turn({ progress: progress({ missing: [], nextStep: 'Review it.', complete: true }) }));
    mockBuildPlan.mockResolvedValue(
      turn({
        session: session({ state: 'reviewing', planHash: 'a'.repeat(64) }),
        reply: 'Here is the whole campaign.',
        plan: plan(),
        progress: progress({ missing: [], nextStep: 'Review it.', complete: true }),
      }),
    );
    mockConfirm.mockResolvedValue(created());
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Review the campaign' }));
    expect(
      await screen.findByText(/the assistant never submits a campaign for approval/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    const handOff = await screen.findByRole('region', { name: /Created as draft/ });
    expect(handOff).toHaveTextContent(/has not been submitted for approval/i);
  });
});

describe('TC-9 — "Change something" keeps every answer', () => {
  it('returns to the conversation with the composer and the progress list intact', async () => {
    const user = userEvent.setup();
    openWith(turn({ progress: progress({ missing: [], nextStep: 'Review it.', complete: true }) }));
    mockBuildPlan.mockResolvedValue(
      turn({
        session: session({ state: 'reviewing', planHash: 'a'.repeat(64) }),
        reply: 'Here is the whole campaign.',
        plan: plan(),
        progress: progress({ missing: [], nextStep: 'Review it.', complete: true }),
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Review the campaign' }));
    await user.click(await screen.findByRole('button', { name: 'Change something' }));

    expect(
      screen.queryByRole('heading', { name: 'Review before creating' }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Your message')).toBeEnabled();
    // Nothing was sent and nothing was created — the answers live in the session, server-side.
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    // Still offered, because the answers are still complete.
    expect(screen.getByRole('button', { name: 'Review the campaign' })).toBeInTheDocument();
  });
});

describe('TC-10 — the model is unavailable', () => {
  it('shows §9’s banner and a working wizard link when the session cannot even open', async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue([]);
    mockStart.mockRejectedValue(
      new ApiError({
        code: 'AGENT_LLM_UNAVAILABLE',
        message: 'The assistant is unavailable.',
        status: 503,
      }),
    );
    renderPage();

    expect(
      await screen.findByText(
        /The assistant is unavailable — you can still create this campaign in the wizard/,
      ),
    ).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'Create this campaign in the wizard' });
    expect(link).toHaveAttribute('href', '/campaigns/new');
    await user.click(link);
    expect(await screen.findByRole('heading', { name: 'Campaign wizard' })).toBeInTheDocument();
  });

  it('shows the same banner when the model dies mid-conversation', async () => {
    openWith();
    mockSend.mockRejectedValue(
      new ApiError({
        code: 'AGENT_LLM_UNAVAILABLE',
        message: 'The assistant is unavailable.',
        status: 503,
      }),
    );
    renderPage();
    await screen.findByText('What should this campaign do?');

    await typeAndSend('A weekend cashback campaign');

    expect(
      await screen.findByText(/The assistant is unavailable — you can still create this campaign/),
    ).toBeInTheDocument();
    // What the maker said is still on screen — a model outage loses nothing.
    expect(screen.getByText('A weekend cashback campaign')).toBeInTheDocument();
  });

  it('offers the wizard after three turns with no progress (§9’s stall rule)', async () => {
    openWith();
    mockSend.mockResolvedValue(
      turn({
        reply: 'Sorry, could you say that again?',
        progress: progress({ offerWizard: true }),
      }),
    );
    renderPage();
    await screen.findByText('What should this campaign do?');

    await typeAndSend('something the model cannot use');

    expect(
      await screen.findByText(/This conversation is not getting anywhere/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Create this campaign in the wizard' }),
    ).toHaveAttribute('href', '/campaigns/new');
  });
});

describe('TC-11 / TC-22 — a stalled turn and a dropped connection', () => {
  it('a 30-second stall is reported with a retry, never an endless spinner', async () => {
    openWith();
    mockSend.mockRejectedValue(
      new ApiError({
        code: 'AGENT_TURN_TIMEOUT',
        message: 'The assistant did not answer within 30 seconds.',
        status: 0,
      }),
    );
    renderPage();
    await screen.findByText('What should this campaign do?');

    await typeAndSend('A weekend cashback campaign');

    expect(await screen.findByRole('alert')).toHaveTextContent('did not answer within 30 seconds');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('retry re-reads the session, and re-sends only the message the server never saw', async () => {
    const user = userEvent.setup();
    openWith();
    mockSend
      .mockRejectedValueOnce(
        new ApiError({ code: 'NETWORK_ERROR', message: 'You appear to be offline.', status: 0 }),
      )
      .mockResolvedValueOnce(turn({ reply: 'Got it — which merchants?' }));
    mockResume.mockResolvedValue(
      detail({
        // The server never recorded the maker's message — the request died before it landed.
        events: [
          {
            seq: 1,
            role: 'assistant',
            content: 'What should this campaign do?',
            at: '2026-08-20T09:00:00.000Z',
          },
        ],
        progress: progress({ missing: ['merchants'], nextStep: 'Which merchants?' }),
      }),
    );
    renderPage();
    await screen.findByText('What should this campaign do?');

    await typeAndSend('A weekend cashback campaign');
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await stream().findByText('Got it — which merchants?')).toBeInTheDocument();
    expect(mockResume).toHaveBeenCalledWith(SESSION_ID);
    expect(mockSend).toHaveBeenCalledTimes(2);
    // The slots survived the drop: the server's own progress block is what is rendered.
    expect(screen.getByText('Participating merchants')).toBeInTheDocument();
  });

  it('does not re-send a message the server did record, so a lost response is not a duplicate turn', async () => {
    const user = userEvent.setup();
    openWith();
    mockSend.mockRejectedValueOnce(
      new ApiError({
        code: 'AGENT_TURN_TIMEOUT',
        message: 'The assistant did not answer within 30 seconds.',
        status: 0,
      }),
    );
    mockResume.mockResolvedValue(
      detail({
        events: [
          {
            seq: 1,
            role: 'assistant',
            content: 'What should this campaign do?',
            at: '2026-08-20T09:00:00.000Z',
          },
          {
            seq: 2,
            role: 'user',
            content: 'A weekend cashback campaign',
            at: '2026-08-20T09:01:00.000Z',
          },
          {
            seq: 3,
            role: 'assistant',
            content: 'Which merchants take part?',
            at: '2026-08-20T09:01:30.000Z',
          },
        ],
      }),
    );
    renderPage();
    await screen.findByText('What should this campaign do?');

    await typeAndSend('A weekend cashback campaign');
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await stream().findByText('Which merchants take part?')).toBeInTheDocument();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('TC-12 — a policy violation from the server', () => {
  it('renders the server’s explanation and its codes where the maker is looking', async () => {
    const user = userEvent.setup();
    openWith(turn({ progress: progress({ missing: [], nextStep: 'Review it.', complete: true }) }));
    mockBuildPlan.mockRejectedValue(
      new ApiError({
        code: 'AGENT_POLICY_VIOLATION',
        message:
          "This tenant's ceiling for one MYR campaign is 200000.00, and 250000.00 is above it.",
        status: 422,
        details: [{ field: 'plan', code: 'BUDGET_ABOVE_TENANT_CEILING' }],
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Review the campaign' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('ceiling for one MYR campaign is 200000.00');
    expect(alert).toHaveTextContent('budget above tenant ceiling');
    // A violation is a constraint to read, not a failure to retry.
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Review before creating' }),
    ).not.toBeInTheDocument();
  });

  it('a refusal at confirm time is announced once, inside the panel it refers to', async () => {
    const user = userEvent.setup();
    openWith(turn({ progress: progress({ missing: [], nextStep: 'Review it.', complete: true }) }));
    mockBuildPlan.mockResolvedValue(
      turn({
        session: session({ state: 'reviewing', planHash: 'a'.repeat(64) }),
        reply: 'Here is the whole campaign.',
        plan: plan(),
        progress: progress({ missing: [], nextStep: 'Review it.', complete: true }),
      }),
    );
    mockConfirm.mockRejectedValue(
      new ApiError({
        code: 'AGENT_POLICY_VIOLATION',
        message: 'A merchant in this campaign is no longer active.',
        status: 422,
        details: [{ field: 'plan', code: 'MERCHANT_NOT_RESOLVABLE' }],
      }),
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Review the campaign' }));
    await user.click(await screen.findByRole('button', { name: 'Create draft' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent('no longer active');
    // The plan is still on screen: the maker changes something and tries again.
    expect(screen.getByRole('heading', { name: 'Review before creating' })).toBeInTheDocument();
  });
});

describe('TC-16 — a keyboard-only maker can complete the conversation', () => {
  it('types, sends, picks a chip and creates the draft without a mouse', async () => {
    const user = userEvent.setup();
    openWith();
    mockSend
      .mockResolvedValueOnce(
        turn({ reply: 'Which merchants take part?', options: MERCHANT_OPTIONS }),
      )
      .mockResolvedValueOnce(
        turn({
          reply: 'Everything is answered.',
          progress: progress({ missing: [], nextStep: 'Review it.', complete: true }),
        }),
      );
    mockBuildPlan.mockResolvedValue(
      turn({
        session: session({ state: 'reviewing', planHash: 'a'.repeat(64) }),
        reply: 'Here is the whole campaign.',
        plan: plan(),
        progress: progress({ missing: [], nextStep: 'Review it.', complete: true }),
      }),
    );
    mockConfirm.mockResolvedValue(created());
    renderPage();
    await screen.findByText('What should this campaign do?');

    const composer = screen.getByLabelText('Your message');
    composer.focus();
    await user.keyboard('A weekend cashback campaign');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveFocus();
    await user.keyboard('{Enter}');

    const chip = await screen.findByRole('button', { name: /Acme Electronics/ });
    chip.focus();
    await user.keyboard('{Enter}');
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Use these merchants' })).toHaveFocus();
    await user.keyboard('{Enter}');

    const review = await screen.findByRole('button', { name: 'Review the campaign' });
    review.focus();
    await user.keyboard('{Enter}');

    // TC-17 — focus lands on the panel that just appeared, not at the bottom of the stream.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Review before creating' })).toHaveFocus();
    });

    const create = screen.getByRole('button', { name: 'Create draft' });
    create.focus();
    await user.keyboard('{Enter}');

    expect(
      await screen.findByRole('heading', { name: /Created as draft RAYA-2026/ }),
    ).toHaveFocus();
  });
});

describe('starting over', () => {
  it('abandons the live session and opens a new one', async () => {
    const user = userEvent.setup();
    openWith(turn({ reply: 'First conversation.' }));
    mockAbandon.mockResolvedValue(session({ state: 'abandoned' }));
    mockStart.mockResolvedValueOnce(turn({ reply: 'First conversation.' }));
    renderPage();
    await screen.findByText('First conversation.');

    mockStart.mockResolvedValueOnce(turn({ reply: 'Second conversation.' }));
    await user.click(screen.getByRole('button', { name: 'Start over' }));

    expect(await screen.findByText('Second conversation.')).toBeInTheDocument();
    expect(mockAbandon).toHaveBeenCalledWith(SESSION_ID);
    expect(screen.queryByText('First conversation.')).not.toBeInTheDocument();
  });
});

describe('TC-19 — 375 px viewport', () => {
  it('the layout stacks and the chip row wraps rather than overflowing', async () => {
    openWith(turn({ reply: 'Which merchants?', options: MERCHANT_OPTIONS }));
    const { container } = renderPage();
    await screen.findByText('Which merchants?');

    // The two columns are a `lg:` breakpoint only, so a 375 px viewport gets one column…
    const grid = container.querySelector('.lg\\:grid-cols-\\[minmax\\(0\\,1fr\\)_18rem\\]');
    expect(grid).not.toBeNull();
    // …and the chips wrap instead of forcing a horizontal scroll.
    expect(screen.getByRole('group', { name: 'Merchants you can choose' }).className).toContain(
      'flex-wrap',
    );
  });
});
