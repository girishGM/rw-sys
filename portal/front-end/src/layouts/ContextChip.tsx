/**
 * T-023 — "which world am I in", always visible, never a click away (04-FRONTEND.md §1).
 * `super_admin` (every scope id `null`) reads as `Global`; everyone else reads as
 * `{country}` or `{country} · {tenant}`, whichever levels their scope actually carries.
 */
import { Badge } from '../components/Badge';
import { useBootstrap } from '../auth/useBootstrap';
import { useScopeLabels } from './useScopeLabels';

export function ContextChip() {
  const { scope } = useBootstrap();
  const { countryLabel, tenantLabel } = useScopeLabels(scope);

  const parts = [countryLabel, tenantLabel].filter((label): label is string => label !== null);
  const text = parts.length > 0 ? parts.join(' · ') : 'Global';

  return (
    <Badge tone="slate" className="whitespace-nowrap">
      {text}
    </Badge>
  );
}
