/**
 * T-006 — the demo-customer context, its hook, and the shared value type `CustomerProvider.tsx`
 * and `components/CustomerSwitcher.tsx` both need. Split out from `CustomerProvider.tsx` the same
 * way `useTheme.ts` is split from `ThemeProvider.tsx` (T-005) — see that file's own header for
 * why: `eslint-plugin-react-refresh`'s `only-export-components` rule (this workspace's lint gate
 * runs at `--max-warnings=0`) flags a non-component export sitting in the same file as an
 * exported component.
 */
import { createContext, useContext } from 'react';
import type { Customer } from '../types';

export interface CustomerContextValue {
  readonly customers: readonly Customer[];
  /** `null` until the roster (`GET /api/customers`) has loaded and a default has been picked —
   * `lib/sseClient.ts`'s `useSse` treats `null` as "don't connect yet" for exactly this reason. */
  readonly customerId: string | null;
  readonly customer: Customer | null;
  readonly isLoading: boolean;
  setCustomerId: (id: string) => void;
}

export const CustomerContext = createContext<CustomerContextValue | null>(null);

/** Reads the current customer + switcher from the nearest `<CustomerProvider>`. */
export function useCustomer(): CustomerContextValue {
  const ctx = useContext(CustomerContext);
  if (!ctx) {
    throw new Error('useCustomer() must be called within a <CustomerProvider>.');
  }
  return ctx;
}
