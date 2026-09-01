// T-005 — Stripe Points / cashback reward-type iconography (ARCHITECTURE.md §4 "My Rewards").
import { IconBase, type IconProps } from './IconBase';

export function CreditCardIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
      <line x1="1" y1="10" x2="23" y2="10" />
    </IconBase>
  );
}
