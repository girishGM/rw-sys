/**
 * T-040 — TC-22 ("axe scan of both screens"), the notifications half.
 *
 * `NotificationBell`/`layouts/notificationsApi.ts` are T-023's own files
 * (`front-end/src/layouts/**`), not this task's — this file only *imports* the already-built,
 * already-tested component (read-only, per AGENT-PROTOCOL R9) to drive a real `axe-core` scan
 * against it now that T-040 has shipped the backend `layouts/notificationsApi.ts`'s own header
 * names as the reason its contract wasn't exercised against a real server before. Same technique
 * `features/trace/a11y.test.tsx` (T-045) and `features/audit/a11y.test.tsx` (this task) both use:
 * a direct `axe.run()` against jsdom-rendered output, `color-contrast`/`color-contrast-enhanced`
 * excluded (jsdom has no real layout/paint engine to evaluate them honestly), every other rule in
 * axe-core's default set enabled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as axe from 'axe-core';
import { NotificationBell } from '../../layouts/NotificationBell';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

vi.mock('../../lib/apiClient', () => ({ api: { get: mockGet, post: mockPost } }));

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

function renderBell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NotificationBell />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  mockGet.mockReset();
  mockPost.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TC-22 — axe-core scan of the notification bell, zero violations', () => {
  it('the closed bell, no unread, has no violations', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count') {
        return Promise.resolve({ data: { data: { count: 0 } } });
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const { container } = renderBell();
    await screen.findByRole('button', { name: 'Notifications' });
    await scan(container, 'Closed bell, no unread');
  });

  it('the closed bell with an unread badge has no violations', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count') {
        return Promise.resolve({ data: { data: { count: 5 } } });
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const { container } = renderBell();
    await screen.findByRole('button', { name: 'Notifications, 5 unread' });
    await scan(container, 'Closed bell, 5 unread');
  });

  it('the open drawer, populated, has no violations', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count') {
        return Promise.resolve({ data: { data: { count: 2 } } });
      }
      if (path === '/notifications') {
        return Promise.resolve({
          data: {
            data: [
              {
                id: 1,
                message: 'Campaign approved',
                isRead: false,
                createdAt: '2026-08-19T00:00:00Z',
              },
              {
                id: 2,
                message: 'Reward updated',
                isRead: true,
                createdAt: '2026-08-18T00:00:00Z',
              },
            ],
          },
        });
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const user = userEvent.setup();
    const { container } = renderBell();
    const button = await screen.findByRole('button', { name: 'Notifications, 2 unread' });
    await user.click(button);
    await screen.findByText('Campaign approved');
    await scan(container, 'Open drawer, populated');
  });

  it('the open drawer, empty state, has no violations', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count') {
        return Promise.resolve({ data: { data: { count: 0 } } });
      }
      if (path === '/notifications') return Promise.resolve({ data: { data: [] } });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const user = userEvent.setup();
    const { container } = renderBell();
    const button = await screen.findByRole('button', { name: 'Notifications' });
    await user.click(button);
    await screen.findByText('No notifications');
    await scan(container, 'Open drawer, empty');
  });

  it('the open drawer, error state, has no violations', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count') {
        return Promise.resolve({ data: { data: { count: 0 } } });
      }
      if (path === '/notifications') {
        return Promise.reject({ isAxiosError: true, response: { status: 500 }, message: 'boom' });
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const user = userEvent.setup();
    const { container } = renderBell();
    const button = await screen.findByRole('button', { name: 'Notifications' });
    await user.click(button);
    await screen.findByText("Couldn't load notifications");
    await scan(container, 'Open drawer, error');
  });
});
