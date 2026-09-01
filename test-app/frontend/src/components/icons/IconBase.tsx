/**
 * T-005 — shared inline-SVG wrapper (UI-UX-DESIGN.md "Icons": "inline stroke SVGs only (24px
 * viewbox, ~1.8-2.2 stroke width), never emoji"). Every icon in this folder renders through
 * this so the viewBox/stroke conventions live in exactly one place instead of being repeated
 * per icon. Icons default to `aria-hidden` since every current call site pairs one with visible
 * text (UI-UX-DESIGN.md content rules never use an icon as the *only* label) — pass
 * `aria-hidden={false}` plus a `title`/`aria-label` for the rare icon-only case.
 */
import type { ReactNode, SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement>;

export function IconBase({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}
