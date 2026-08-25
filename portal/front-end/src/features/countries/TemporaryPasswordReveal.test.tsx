import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TemporaryPasswordReveal } from './TemporaryPasswordReveal';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TemporaryPasswordReveal', () => {
  it('hides the password until Reveal is clicked (BACKLOG B-01 / T-030 implementation note 5)', async () => {
    const user = userEvent.setup();
    render(
      <TemporaryPasswordReveal email="admin@example.invalid" temporaryPassword="s3cr3t!Value" />,
    );

    const value = screen.getByTestId('temporary-password-value');
    expect(value.textContent).toBe('•'.repeat('s3cr3t!Value'.length));
    expect(value.textContent).not.toContain('s3cr3t');

    await user.click(screen.getByRole('button', { name: /reveal/i }));
    expect(value.textContent).toBe('s3cr3t!Value');

    await user.click(screen.getByRole('button', { name: /hide/i }));
    expect(value.textContent).not.toContain('s3cr3t');
  });

  it('the copy button is disabled until the password is revealed', async () => {
    const user = userEvent.setup();
    render(
      <TemporaryPasswordReveal email="admin@example.invalid" temporaryPassword="s3cr3t!Value" />,
    );

    expect(screen.getByRole('button', { name: /copy/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /reveal/i }));
    expect(screen.getByRole('button', { name: /copy/i })).toBeEnabled();
  });

  it('copies to the clipboard and never persists the value anywhere else', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <TemporaryPasswordReveal email="admin@example.invalid" temporaryPassword="s3cr3t!Value" />,
    );
    await user.click(screen.getByRole('button', { name: /reveal/i }));
    await user.click(screen.getByRole('button', { name: /copy/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('s3cr3t!Value'));
    // Never written to localStorage/sessionStorage — see the component's own header.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('shows the persistent one-time warning', () => {
    render(
      <TemporaryPasswordReveal email="admin@example.invalid" temporaryPassword="s3cr3t!Value" />,
    );
    expect(screen.getByText(/will not be shown again/i)).toBeInTheDocument();
  });
});
