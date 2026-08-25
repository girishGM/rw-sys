/**
 * T-020 — mounts the bootstrap query and publishes it on `BootstrapContext` for
 * `useBootstrap()` (04-FRONTEND.md §2 implementation note 2).
 *
 * This file exports **only** the `<BootstrapProvider>` component — see the banner in
 * `useBootstrap.ts` for why the query, the context object and its type all live there
 * instead of here.
 */
import { useMemo, type ReactNode } from 'react';
import {
  BootstrapContext,
  isPasswordChangeRequiredError,
  isUnauthorizedError,
  useBootstrapQuery,
  type BootstrapContextValue,
} from './useBootstrap';

const EMPTY_NAV: BootstrapContextValue['nav'] = [];
const EMPTY_WIDGETS: BootstrapContextValue['widgets'] = [];
const EMPTY_PERMISSIONS: BootstrapContextValue['permissions'] = {};
const EMPTY_MESSAGES: BootstrapContextValue['messages'] = {};

export function BootstrapProvider({ children }: { children: ReactNode }) {
  const query = useBootstrapQuery();
  const { data, isPending, isError, error, refetch } = query;

  const value = useMemo<BootstrapContextValue>(() => {
    const permissions = data?.permissions ?? EMPTY_PERMISSIONS;
    return {
      user: data?.user,
      scope: data?.scope,
      nav: data?.nav ?? EMPTY_NAV,
      permissions,
      widgets: data?.widgets ?? EMPTY_WIDGETS,
      messages: data?.messages ?? EMPTY_MESSAGES,
      isLoading: isPending,
      isError,
      isUnauthorized: isError && isUnauthorizedError(error),
      isPasswordChangeRequired: isError && isPasswordChangeRequiredError(error),
      hasPermission: (entity: string, action: string) =>
        permissions[entity]?.includes(action) ?? false,
      refetch: () => void refetch(),
    };
  }, [data, isPending, isError, error, refetch]);

  return <BootstrapContext.Provider value={value}>{children}</BootstrapContext.Provider>;
}
