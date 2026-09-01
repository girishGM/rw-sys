// T-005 — disclosure/collapse affordances (e.g. profile chip chevron, UI-UX-DESIGN.md "Header").
import { IconBase, type IconProps } from './IconBase';

export function ChevronDownIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <polyline points="6 9 12 15 18 9" />
    </IconBase>
  );
}
