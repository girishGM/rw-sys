// T-006 — the mobile header's hamburger control (UI-UX-DESIGN.md "Responsive rules": "header
// collapses to logo + avatar + hamburger icon").
import { IconBase, type IconProps } from './IconBase';

export function MenuIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </IconBase>
  );
}
