/**
 * T-049 TC-18 — *"axe scan: zero violations"*.
 *
 * The same real `axe-core`-engine approach `features/approvals/a11y.test.tsx` (T-038) and
 * `features/versions/a11y.test.tsx` (T-041) established — see those files for why this is a genuine
 * scan rather than a heuristic substitute, and for the one honest jsdom limitation
 * (`color-contrast`, which needs real layout and paint) that is excluded.
 *
 * Six states are scanned, because a conversational screen changes shape more than a form does: the
 * opening, a turn offering chips, a turn in flight (the live region is `aria-busy`), the review
 * panel, the hand-off, and the wizard-fallback banner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as axe from 'axe-core';

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
import { MERCHANT_OPTIONS, created, plan, progress, session, turn } from './fixtures';

const JSDOM_LAYOUT_DEPENDENT_RULES = ['color-contrast', 'color-contrast-enhanced'];

async function scan(container: HTMLElement, label: string) {
  const results = await axe.run(container, {
    rules: Object.fromEntries(JSDOM_LAYOUT_DEPENDENT_RULES.map((id) => [id, { enabled: false }])),
  });
  const violations = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target),
  }));
  expect(violations, `${label}: axe-core violations`).toEqual([]);
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/campaigns/assistant']}>
        <AgentChatPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const COMPLETE = progress({ missing: [], nextStep: 'Review it.', complete: true });

const REVIEW_TURN = turn({
  session: session({ state: 'reviewing', planHash: 'a'.repeat(64) }),
  reply: 'Here is the whole campaign.',
  plan: plan(),
  progress: COMPLETE,
});

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
  mockList.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

describe('TC-18 — axe scan', () => {
  it('the opening conversation has no violations', async () => {
    mockStart.mockResolvedValue(turn({ reply: 'What should this campaign do?' }));
    const { container } = renderPage();

    await screen.findByText('What should this campaign do?');
    await scan(container, 'AgentChatPage — opening');
  });

  it('a turn offering chips has no violations', async () => {
    mockStart.mockResolvedValue(
      turn({ reply: 'Which merchants take part?', options: MERCHANT_OPTIONS }),
    );
    const { container } = renderPage();

    await screen.findByRole('group', { name: 'Merchants you can choose' });
    await scan(container, 'AgentChatPage — chips');
  });

  it('a turn in flight (typing indicator, busy live region) has no violations', async () => {
    mockStart.mockResolvedValue(turn({ reply: 'What should this campaign do?' }));
    mockSend.mockImplementation(() => new Promise(() => undefined));
    const { container } = renderPage();

    await screen.findByText('What should this campaign do?');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Your message'), 'A weekend cashback campaign');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByRole('status');
    await scan(container, 'AgentChatPage — turn in flight');
  });

  it('the review panel has no violations', async () => {
    mockStart.mockResolvedValue(turn({ progress: COMPLETE }));
    mockBuildPlan.mockResolvedValue(REVIEW_TURN);
    const { container } = renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Review the campaign' }));

    await screen.findByRole('heading', { name: 'Review before creating' });
    await scan(container, 'AgentChatPage — review panel');
  });

  it('the hand-off has no violations', async () => {
    mockStart.mockResolvedValue(turn({ progress: COMPLETE }));
    mockBuildPlan.mockResolvedValue(REVIEW_TURN);
    mockConfirm.mockResolvedValue(created());
    const { container } = renderPage();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Review the campaign' }));
    await user.click(await screen.findByRole('button', { name: 'Create draft' }));

    await screen.findByRole('heading', { name: /Created as draft/ });
    await scan(container, 'AgentChatPage — hand-off');
  });

  it('the wizard-fallback banner has no violations', async () => {
    mockStart.mockRejectedValue(
      new ApiError({
        code: 'AGENT_LLM_UNAVAILABLE',
        message: 'The assistant is unavailable.',
        status: 503,
      }),
    );
    const { container } = renderPage();

    await screen.findByRole('link', { name: 'Create this campaign in the wizard' });
    await scan(container, 'AgentChatPage — unavailable banner');
  });
});
