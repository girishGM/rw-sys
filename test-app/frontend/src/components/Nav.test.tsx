/**
 * T-006 — TC-1/TC-4/TC-5: the nav pills highlight the active route (including a sub-route like
 * `/campaigns/:code` keeping the "Campaigns" pill active), and the mobile hamburger opens a real,
 * keyboard-reachable drawer containing the same nav links plus the theme/customer switchers —
 * not just visually hidden desktop controls.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Nav } from './Nav';
import { ThemeProvider } from '../app/ThemeProvider';
import { CustomerContext, type CustomerContextValue } from '../app/useCustomer';

const CUSTOMER_VALUE: CustomerContextValue = {
  customers: [
    { id: 'priya-shah', displayName: 'Priya Shah', avatarInitials: 'PS' },
    { id: 'marcus-tan', displayName: 'Marcus Tan', avatarInitials: 'MT' },
  ],
  customerId: 'priya-shah',
  customer: { id: 'priya-shah', displayName: 'Priya Shah', avatarInitials: 'PS' },
  isLoading: false,
  setCustomerId: () => {},
};

function renderNav(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ThemeProvider>
        <CustomerContext.Provider value={CUSTOMER_VALUE}>
          <Nav />
        </CustomerContext.Provider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('Nav', () => {
  it('highlights the Dashboard pill at "/" and only that one', () => {
    renderNav('/');
    const primary = screen.getAllByRole('navigation', { name: 'Primary' })[0];
    expect(within(primary).getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(primary).getByRole('link', { name: 'Campaigns' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('keeps the Campaigns pill active on a campaign detail sub-route', () => {
    renderNav('/campaigns/SUMMER25');
    const primary = screen.getAllByRole('navigation', { name: 'Primary' })[0];
    expect(within(primary).getByRole('link', { name: 'Campaigns' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('opens a real drawer from the mobile hamburger, containing nav links + both switchers', async () => {
    const user = userEvent.setup();
    renderNav('/rewards');

    await user.click(screen.getByRole('button', { name: 'Open menu' }));

    const dialog = screen.getByRole('dialog', { name: 'Menu' });
    expect(within(dialog).getByRole('link', { name: 'My Rewards' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(dialog).getByText('Theme')).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: 'Choose a theme' })).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: /switch customer/i })).toBeInTheDocument();
  });

  it('closes the drawer via its close button', async () => {
    const user = userEvent.setup();
    renderNav('/');

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close menu' }));
    expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument();
  });

  it('clicking a nav link inside the drawer closes it', async () => {
    const user = userEvent.setup();
    renderNav('/');

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const dialog = screen.getByRole('dialog', { name: 'Menu' });
    await user.click(within(dialog).getByRole('link', { name: 'Activity' }));

    expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument();
  });
});
