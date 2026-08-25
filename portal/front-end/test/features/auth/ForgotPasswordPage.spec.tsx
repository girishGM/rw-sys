import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ForgotPasswordPage } from '../../../src/features/auth/ForgotPasswordPage';

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));

vi.mock('../../../src/lib/apiClient', () => ({ api: { post: mockPost } }));

const SAME_MESSAGE = "If an account exists for that email, we've sent a reset link.";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/forgot-password']}>
        <ForgotPasswordPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockPost.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ForgotPasswordPage', () => {
  it('TC-12: a known email shows the fixed success message', async () => {
    mockPost.mockResolvedValue({ data: undefined });
    renderPage();
    await userEvent.type(screen.getByLabelText('Email'), 'known@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    await waitFor(() => expect(screen.getByText(SAME_MESSAGE)).toBeInTheDocument());
  });

  it('TC-13: an unknown email shows the byte-identical success message', async () => {
    // The server always answers 204, whichever it was — there is no other branch to take.
    mockPost.mockResolvedValue({ data: undefined });
    renderPage();
    await userEvent.type(screen.getByLabelText('Email'), 'unknown@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    await waitFor(() => expect(screen.getByText(SAME_MESSAGE)).toBeInTheDocument());
  });

  it('posts only the email address', async () => {
    mockPost.mockResolvedValue({ data: undefined });
    renderPage();
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/auth/forgot-password', { email: 'a@b.com' }),
    );
  });

  it('a real failure (network/500) shows an error instead of the success message', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: undefined,
      message: 'Network Error',
    });
    renderPage();
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    await screen.findByRole('alert');
    expect(screen.queryByText(SAME_MESSAGE)).not.toBeInTheDocument();
  });

  it('requires a validly-formatted email before submitting', async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(mockPost).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
  });
});
