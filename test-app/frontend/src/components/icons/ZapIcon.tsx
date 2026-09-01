// T-005 — Activity Simulator iconography (ARCHITECTURE.md §4 "Activity Simulator").
import { IconBase, type IconProps } from './IconBase';

export function ZapIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </IconBase>
  );
}
