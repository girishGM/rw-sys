// T-005 — promo-code reward-type iconography (ARCHITECTURE.md §4 "My Rewards").
import { IconBase, type IconProps } from './IconBase';

export function TagIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </IconBase>
  );
}
