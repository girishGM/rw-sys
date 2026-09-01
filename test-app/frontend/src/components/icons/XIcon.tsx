// T-006 — the mobile nav drawer's close control (`components/Nav.tsx`'s `Dialog.Close`).
import { IconBase, type IconProps } from './IconBase';

export function XIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </IconBase>
  );
}
