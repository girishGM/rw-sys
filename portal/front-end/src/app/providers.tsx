/**
 * T-020 — the app-wide provider tree (04-FRONTEND.md §9: "Server state: TanStack Query").
 *
 * **T-022 update:** this file originally built its own minimal, local `QueryClient`, with a
 * note that T-022 owns the real shared instance in `lib/queryClient.ts` (the full default
 * policy from 04-FRONTEND.md §8:
 * `retry: (count, err) => count < 2 && ![401,403,404].includes(err.status)`, plus a
 * `Retry-After`-aware `retryDelay`) and that swapping it in here was "a one-file change
 * confined to this component when T-022 lands". That swap is made below.
 *
 * It is not cosmetic: `lib/apiClient.ts`'s `endSession()` (called when a token refresh
 * fails) calls `queryClient.clear()` on this exact instance. Two different `QueryClient`s
 * mounted in the same app would make that a no-op on whichever one `<AppProviders>`
 * actually renders from — the previous user's cached data would survive a failed refresh
 * on a shared machine, which is precisely the leak 04-FRONTEND.md §9 calls out. `useLogout`
 * (`auth/useBootstrap.ts`) is unaffected: it already reads the ambient client via
 * `useQueryClient()` rather than importing an instance directly.
 */
import { type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../lib/queryClient';

export function AppProviders({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
