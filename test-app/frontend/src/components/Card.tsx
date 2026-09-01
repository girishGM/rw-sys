/**
 * T-005 — the mockup's `.glass` treatment (UI-UX-DESIGN.md "Core components") as a real,
 * reusable component instead of copy-pasted inline styles per page. `.glass` (`styles/
 * tokens.css`) carries the background/border/shadow/backdrop-filter (plus its `@supports`
 * fallback); this component adds only the rounded-corner radius on top, via the Tailwind
 * `rounded-card` utility `tailwind.config.ts` maps to `--radius-card` — so callers still
 * customise spacing/width/etc. through the normal `className` prop.
 */
import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';
import { cx } from './internal/cx';

export type CardProps = HTMLAttributes<HTMLDivElement>;

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, children, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cx('glass rounded-card', className)} {...rest}>
      {children}
    </div>
  );
});
