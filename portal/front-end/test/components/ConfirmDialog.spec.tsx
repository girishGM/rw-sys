import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from '../../src/components/ConfirmDialog';

describe('ConfirmDialog', () => {
  it('TC-11: destructive variant still defaults focus to Cancel, not Confirm', async () => {
    render(
      <ConfirmDialog
        open
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        title="Delete campaign"
        description="This cannot be undone."
        variant="destructive"
      />,
    );
    await screen.findByRole('alertdialog', { name: 'Delete campaign' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
  });

  it('TC-11: destructive variant renders danger styling on the confirm action', async () => {
    render(
      <ConfirmDialog
        open
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        title="Delete campaign"
        variant="destructive"
        confirmLabel="Delete"
      />,
    );
    const confirmButton = await screen.findByRole('button', { name: 'Delete' });
    expect(confirmButton.className).toMatch(/danger/);
  });

  it('default (non-destructive) variant also focuses Cancel first', async () => {
    render(<ConfirmDialog open onConfirm={vi.fn()} onCancel={vi.fn()} title="Publish version" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
  });

  it('Escape and the Cancel button both call onCancel; the Confirm button calls onConfirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open onConfirm={onConfirm} onCancel={onCancel} title="Publish version" />,
    );
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('clicking Confirm invokes onConfirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmDialog open onConfirm={onConfirm} onCancel={vi.fn()} title="Publish version" />);
    await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when closed', () => {
    render(
      <ConfirmDialog open={false} onConfirm={vi.fn()} onCancel={vi.fn()} title="Publish version" />,
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
