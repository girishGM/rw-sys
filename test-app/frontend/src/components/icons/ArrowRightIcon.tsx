// T-005 — the toast's "View in My Rewards" link (UI-UX-DESIGN.md "Core components": Toast).
import { IconBase, type IconProps } from './IconBase';

export function ArrowRightIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </IconBase>
  );
}
