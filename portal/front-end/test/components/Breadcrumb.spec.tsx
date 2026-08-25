import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Breadcrumb } from '../../src/components/Breadcrumb';

describe('Breadcrumb', () => {
  it('TC-1: marks the final crumb aria-current="page" and links the rest', () => {
    render(
      <Breadcrumb
        items={[{ label: 'Campaigns', href: '/campaigns' }, { label: 'Summer Promo' }]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Campaigns' })).toBeInTheDocument();
    expect(screen.getByText('Summer Promo')).toHaveAttribute('aria-current', 'page');
  });

  it('supports click-based crumbs (no href) for programmatic navigation', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Breadcrumb items={[{ label: 'Campaigns', onClick }, { label: 'Summer Promo' }]} />);
    await user.click(screen.getByRole('button', { name: 'Campaigns' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
