/**
 * T-006 — `CustomerProvider`'s own contract: fetches the roster, defaults to the *first* customer
 * once it loads (ARCHITECTURE.md §4), and `setCustomerId` actually switches the selection —
 * exercised directly against the context rather than through `CustomerSwitcher`'s UI, which has
 * its own test for the dropdown interaction itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as apiClient from '../lib/apiClient';
import { CustomerProvider } from './CustomerProvider';
import { useCustomer } from './useCustomer';

const ROSTER = [
  { id: 'priya-shah', displayName: 'Priya Shah', avatarInitials: 'PS' },
  { id: 'marcus-tan', displayName: 'Marcus Tan', avatarInitials: 'MT' },
];

function Probe() {
  const { customerId, customer, customers, setCustomerId } = useCustomer();
  return (
    <div>
      <div data-testid="customer-id">{customerId ?? 'none'}</div>
      <div data-testid="customer-name">{customer?.displayName ?? 'none'}</div>
      {customers.map((entry) => (
        <button key={entry.id} onClick={() => setCustomerId(entry.id)}>
          {entry.displayName}
        </button>
      ))}
    </div>
  );
}

function renderWithProvider() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <CustomerProvider>
        <Probe />
      </CustomerProvider>
    </QueryClientProvider>,
  );
}

function suppressExpectedReactErrorLogging() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

describe('CustomerProvider', () => {
  beforeEach(() => {
    vi.spyOn(apiClient, 'getCustomers').mockResolvedValue(ROSTER);
  });

  it('defaults to the first customer once the roster loads', async () => {
    renderWithProvider();

    expect(screen.getByTestId('customer-id')).toHaveTextContent('none');
    await waitFor(() => expect(screen.getByTestId('customer-id')).toHaveTextContent('priya-shah'));
    expect(screen.getByTestId('customer-name')).toHaveTextContent('Priya Shah');
  });

  it('setCustomerId switches the selected customer', async () => {
    const user = userEvent.setup();
    renderWithProvider();

    await waitFor(() => expect(screen.getByTestId('customer-id')).toHaveTextContent('priya-shah'));

    await user.click(screen.getByRole('button', { name: 'Marcus Tan' }));

    expect(screen.getByTestId('customer-id')).toHaveTextContent('marcus-tan');
    expect(screen.getByTestId('customer-name')).toHaveTextContent('Marcus Tan');
  });

  it('useCustomer() throws a clear error when used outside a <CustomerProvider>', () => {
    const consoleSpy = suppressExpectedReactErrorLogging();
    expect(() => render(<Probe />)).toThrow(
      'useCustomer() must be called within a <CustomerProvider>.',
    );
    consoleSpy.mockRestore();
  });
});
