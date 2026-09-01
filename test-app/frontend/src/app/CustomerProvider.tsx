/**
 * T-006 — the demo-customer switcher's shared state (ARCHITECTURE.md §4: "Demo-customer switcher
 * ... global, client-side state only [...] customer switch re-fetches from `tracking-service`").
 * Fetches the fixed roster via `useCustomers()` (`lib/queries.ts`) and holds only the *selected*
 * id in plain React state — in-memory only, no persistence, the same pattern `ThemeProvider`
 * (T-005) already established for theme (BACKLOG.md "Theme persistence"). Defaults to the first
 * customer once the roster loads (`ARCHITECTURE.md` §4's "default: the first one", per this
 * task's own Scope).
 *
 * Exports only the `<CustomerProvider>` component — the context, the hook and the shared type
 * live in `./useCustomer.ts` instead (see that file's own header for why).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useCustomers } from '../lib/queries';
import { CustomerContext, type CustomerContextValue } from './useCustomer';

export function CustomerProvider({ children }: { children: ReactNode }) {
  const { data: customers, isLoading } = useCustomers();
  const [customerId, setCustomerId] = useState<string | null>(null);

  useEffect(() => {
    if (customerId === null && customers && customers.length > 0) {
      setCustomerId(customers[0].id);
    }
  }, [customers, customerId]);

  const customer = useMemo(
    () => customers?.find((entry) => entry.id === customerId) ?? null,
    [customers, customerId],
  );

  const value = useMemo<CustomerContextValue>(
    () => ({ customers: customers ?? [], customerId, customer, isLoading, setCustomerId }),
    [customers, customerId, customer, isLoading],
  );

  return <CustomerContext.Provider value={value}>{children}</CustomerContext.Provider>;
}
