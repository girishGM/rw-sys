/**
 * T-002 — root provider tree. T-005 appends `ThemeProvider` (a registration point per
 * AGENT-PROTOCOL.md R3 — "provider trees are append-only"); T-006 appends the demo-customer
 * provider (ARCHITECTURE.md §4) on top of this the same way.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ThemeProvider } from './ThemeProvider';
import { CustomerProvider } from './CustomerProvider';

const queryClient = new QueryClient();

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <CustomerProvider>{children}</CustomerProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
