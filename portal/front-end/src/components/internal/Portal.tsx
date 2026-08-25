import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

let portalRoot: HTMLElement | null = null;

function getPortalRoot(): HTMLElement {
  if (portalRoot && document.body.contains(portalRoot)) return portalRoot;
  portalRoot = document.getElementById('rs-portal-root');
  if (!portalRoot) {
    portalRoot = document.createElement('div');
    portalRoot.id = 'rs-portal-root';
    document.body.appendChild(portalRoot);
  }
  return portalRoot;
}

/**
 * T-021 — renders `children` into a single shared portal root appended to `document.body`,
 * used by `Modal`, `Drawer` and `ConfirmDialog`. A shared root (rather than one div per
 * instance) keeps stacking order predictable.
 *
 * Mounts synchronously (no deferred-to-`useEffect` mount gate) — this is a client-only SPA
 * (04-FRONTEND.md; no SSR in scope), so there's no hydration mismatch to guard against, and
 * deferring by a render would leave `Modal`/`Drawer`'s `useFocusTrap` racing an empty
 * container on the very first paint (T-021 TC-4).
 */
export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, getPortalRoot());
}
