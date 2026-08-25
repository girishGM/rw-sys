import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationBell } from '../../src/layouts/NotificationBell';
import { UNREAD_POLL_INTERVAL_MS } from '../../src/layouts/notificationsApi';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

vi.mock('../../src/lib/apiClient', () => ({ api: { get: mockGet, post: mockPost } }));

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

describe('TC-17: notification bell with 3 unread', () => {
  it('shows the badge and lists them once opened', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count') {
        return Promise.resolve({ data: { data: { count: 3 } } });
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
                message: 'New tenant onboarded',
                isRead: false,
                createdAt: '2026-08-18T00:00:00Z',
              },
              { id: 3, message: 'Reward updated', isRead: true, createdAt: '2026-08-17T00:00:00Z' },
            ],
          },
        });
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });

    const user = userEvent.setup();
    renderBell();

    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Notifications, 3 unread' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Notifications, 3 unread' }));
    const drawer = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(drawer).toHaveTextContent('Campaign approved');
    expect(drawer).toHaveTextContent('New tenant onboarded');
    expect(drawer).toHaveTextContent('Reward updated');
  });
});

describe('no unread notifications', () => {
  it('shows no badge and an empty state in the drawer', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count')
        return Promise.resolve({ data: { data: { count: 0 } } });
      if (path === '/notifications') return Promise.resolve({ data: { data: [] } });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const user = userEvent.setup();
    renderBell();

    const button = await screen.findByRole('button', { name: 'Notifications' });
    expect(button.querySelector('[aria-hidden="true"].bg-danger-600')).not.toBeInTheDocument();

    await user.click(button);
    expect(await screen.findByText('No notifications')).toBeInTheDocument();
  });
});

describe('the unread-count request fails', () => {
  it('degrades to a 0 badge rather than crashing the top bar', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count') {
        return Promise.reject({ isAxiosError: true, response: { status: 500 }, message: 'boom' });
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    renderBell();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });
});

describe('the notifications list request fails', () => {
  it('shows an error message inside the drawer instead of a blank panel', async () => {
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
    renderBell();
    await user.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText("Couldn't load notifications")).toBeInTheDocument();
  });
});

describe('marking every notification read', () => {
  it('POSTs /notifications/read-all and refetches the unread count and list', async () => {
    let unreadCount = 2;
    mockGet.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count') {
        return Promise.resolve({ data: { data: { count: unreadCount } } });
      }
      if (path === '/notifications') {
        return Promise.resolve({
          data: {
            data:
              unreadCount > 0
                ? [
                    {
                      id: 1,
                      message: 'Campaign approved',
                      isRead: false,
                      createdAt: '2026-08-19T00:00:00Z',
                    },
                  ]
                : [],
          },
        });
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    mockPost.mockImplementation(() => {
      unreadCount = 0;
      return Promise.resolve({ data: {} });
    });

    const user = userEvent.setup();
    renderBell();
    await user.click(await screen.findByRole('button', { name: 'Notifications, 2 unread' }));
    await screen.findByText('Campaign approved');

    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));

    expect(mockPost).toHaveBeenCalledWith('/notifications/read-all');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument(),
    );
  });

  it('the action is disabled when there is nothing unread', async () => {
    mockGet.mockImplementation((path: string) => {
      if (path === '/notifications/unread-count')
        return Promise.resolve({ data: { data: { count: 0 } } });
      if (path === '/notifications') return Promise.resolve({ data: { data: [] } });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const user = userEvent.setup();
    renderBell();
    await user.click(await screen.findByRole('button', { name: 'Notifications' }));
    await screen.findByText('No notifications');
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  });
});

describe('polling', () => {
  it('polls the unread count every 60s, not more often', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockGet.mockResolvedValue({ data: { data: { count: 1 } } });

    renderBell();
    await vi.waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));

    await act(() => vi.advanceTimersByTimeAsync(UNREAD_POLL_INTERVAL_MS - 1000));
    expect(mockGet).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(1000));
    await vi.waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  });
});
