import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from '../../src/components/Toast';
import { toast } from '../../src/components/toastActions';

describe('Toast', () => {
  it('TC-10: an enqueued toast is announced via a role="status" aria-live region', async () => {
    render(<Toaster />);
    act(() => {
      toast('Campaign published');
    });
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Campaign published');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('is dismissible by keyboard via the close button', async () => {
    const user = userEvent.setup();
    render(<Toaster />);
    act(() => {
      toast('Version blast complete');
    });
    await screen.findByText('Version blast complete');
    const closeButton = screen.getByRole('button', { name: /close toast/i });
    closeButton.focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(screen.queryByText('Version blast complete')).not.toBeInTheDocument(),
    );
  });
});
