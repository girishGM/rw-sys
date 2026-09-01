// T-005 — expiry-countdown iconography (ARCHITECTURE.md §4 "My Rewards").
import { IconBase, type IconProps } from './IconBase';

export function ClockIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </IconBase>
  );
}
