/**
 * T-006 — TC-2: the customer switcher is a real, working dropdown, not just a visual chip —
 * opening it and picking a different customer actually calls `setCustomerId` (and therefore
 * flows into every `useCustomer()`-reading query, per `CustomerProvider`'s own test).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CustomerSwitcher } from './CustomerSwitcher';
import { CustomerContext, type CustomerContextValue } from '../app/useCustomer';

const CUSTOMERS = [
  { id: 'priya-shah', displayName: 'Priya Shah', avatarInitials: 'PS' },
  { id: 'marcus-tan', displayName: 'Marcus Tan', avatarInitials: 'MT' },
];

function renderSwitcher(overrides: Partial<CustomerContextValue> = {}) {
  const setCustomerId = vi.fn();
  const value: CustomerContextValue = {
    customers: CUSTOMERS,
    customerId: 'priya-shah',
    customer: CUSTOMERS[0],
    isLoading: false,
    setCustomerId,
    ...overrides,
  };
  render(
    <CustomerContext.Provider value={value}>
      <CustomerSwitcher />
    </CustomerContext.Provider>,
  );
  return { setCustomerId };
}

describe('CustomerSwitcher', () => {
  it('shows a loading placeholder while the roster is still loading', () => {
    renderSwitcher({ isLoading: true, customer: null, customers: [] });
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it("renders the currently-selected customer's avatar initials and name", () => {
    renderSwitcher();
    expect(screen.getByText('Priya Shah')).toBeInTheDocument();
    expect(screen.getByText('PS')).toBeInTheDocument();
  });

  it('opening the dropdown and picking another customer calls setCustomerId with its id', () => {
    // Real `pointerdown`/`pointerup` + `click` pairs (not `userEvent.click`, which hangs for
    // real seconds against `@radix-ui/react-select` in jsdom — jsdom implements neither
    // `PointerEvent` capture nor real layout, and Radix's own pointer-capture bookkeeping ends up
    // in a very slow real-time retry loop as a result). This still exercises Radix's real
    // open/select codepath end to end (`Select.Root`'s `onValueChange`), just via `fireEvent`
    // instead.
    const { setCustomerId } = renderSwitcher();
    const trigger = screen.getByRole('combobox', { name: /switch customer/i });

    fireEvent.pointerDown(trigger, { button: 0, pointerId: 1, pointerType: 'mouse' });
    fireEvent.click(trigger);

    const option = screen.getByRole('option', { name: /marcus tan/i });
    fireEvent.pointerUp(option, { button: 0, pointerId: 1, pointerType: 'mouse' });
    fireEvent.click(option);

    expect(setCustomerId).toHaveBeenCalledWith('marcus-tan');
  });
});
