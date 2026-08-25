import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toggle } from '../../src/components/Toggle';

describe('Toggle', () => {
  it('exposes the WAI-ARIA switch pattern', () => {
    render(<Toggle label="Enable notifications" checked={false} onChange={() => {}} />);
    const toggle = screen.getByRole('switch', { name: 'Enable notifications' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('toggles on click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle label="Enable notifications" checked={false} onChange={onChange} />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('is keyboard reachable and toggles on Enter (native button semantics)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle label="Enable notifications" checked={false} onChange={onChange} />);
    await user.tab();
    expect(screen.getByRole('switch')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not toggle while disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle label="Enable notifications" checked={false} onChange={onChange} disabled />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
