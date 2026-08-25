import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Drawer } from '../../src/components/Drawer';

describe('Drawer', () => {
  it('TC-4: renders as a labelled dialog and moves focus inside on open', async () => {
    render(
      <Drawer open onClose={vi.fn()} title="Campaign detail">
        <button type="button">Field</button>
      </Drawer>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Campaign detail' });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
  });

  it('TC-4: Escape closes the panel', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="Campaign detail">
        <button type="button">Field</button>
      </Drawer>,
    );
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when closed', () => {
    render(
      <Drawer open={false} onClose={vi.fn()} title="Campaign detail">
        <button type="button">Field</button>
      </Drawer>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('clicking the backdrop closes the panel', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="Campaign detail">
        <button type="button">Field</button>
      </Drawer>,
    );
    await screen.findByRole('dialog');
    await user.click(screen.getByTestId('drawer-backdrop'));
    expect(onClose).toHaveBeenCalled();
  });
});
