import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '../../src/components/Modal';

function OpenModal({ onClose }: { onClose: () => void }) {
  return (
    <div>
      <button type="button">Trigger</button>
      <Modal open onClose={onClose} title="Delete campaign" description="This cannot be undone.">
        <button type="button">First field</button>
        <button type="button">Second field</button>
      </Modal>
    </div>
  );
}

describe('Modal', () => {
  it('TC-4: renders as a labelled dialog and moves focus inside on open', async () => {
    render(<OpenModal onClose={vi.fn()} />);
    const dialog = await screen.findByRole('dialog', { name: 'Delete campaign' });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
  });

  it('TC-4: Tab is trapped within the dialog', async () => {
    const user = userEvent.setup();
    render(<OpenModal onClose={vi.fn()} />);
    await screen.findByRole('dialog');
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));

    // Cycle Tab enough times to prove focus never escapes to the "Trigger" button outside.
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('TC-4: Escape closes the dialog', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<OpenModal onClose={onClose} />);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('TC-4: closing returns focus to the trigger that opened it', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            Open modal
          </button>
          <Modal open={open} onClose={() => setOpen(false)} title="Delete campaign">
            <button type="button">Confirm</button>
          </Modal>
        </div>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open modal' });
    await user.click(trigger);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('clicking the backdrop closes the dialog', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<OpenModal onClose={onClose} />);
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('modal-backdrop'));
    expect(onClose).toHaveBeenCalled();
  });
});
