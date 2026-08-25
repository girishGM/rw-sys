/**
 * T-020 — the innermost link of the guard chain (04-FRONTEND.md §2, §6). Renders
 * `<Forbidden/>` in place of its children when the caller's permission map (from
 * `/me/bootstrap`) does not grant `action` on `entity`.
 *
 * Because the check happens **before** `children` ever renders, the page component behind
 * it — and whatever data-fetching it would have triggered — never mounts (TC-8: "no data
 * request fired"). As with every other guard in this chain, this is UX only: the matching
 * `role_entity_permissions` row on the server is what actually blocks the request
 * (00-ARCHITECTURE.md §7 / AGENT-PROTOCOL R3) — this component only avoids showing the user
 * a door that the server would slam shut anyway.
 */
import { type ReactNode } from 'react';
import { useBootstrap } from './useBootstrap';
import { Forbidden } from '../pages/Forbidden';

export function RequirePermission({
  entity,
  action,
  children,
}: {
  entity: string;
  action: string;
  children: ReactNode;
}) {
  const { hasPermission } = useBootstrap();

  if (!hasPermission(entity, action)) {
    return <Forbidden />;
  }

  return <>{children}</>;
}
