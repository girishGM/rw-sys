import { useEffect, useRef, type RefObject } from 'react';
import { focusFirst, trapTabKey } from './focus';

/**
 * T-021 — traps focus inside the returned ref's element while `active` is true, and
 * restores focus to whatever was focused before activation once it becomes false again
 * (or the component unmounts while still active). Used by `Modal`, `Drawer` and
 * `ConfirmDialog` (T-021 TC-4).
 *
 * By default focuses the first focusable descendant on open. Pass `initialFocusRef` to
 * focus a specific element instead — `ConfirmDialog`'s destructive variant needs this to
 * land on **Cancel**, not whichever button happens to be DOM-first (T-021 TC-11).
 */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  initialFocusRef?: RefObject<HTMLElement>,
) {
  const containerRef = useRef<T | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return undefined;

    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    if (container) {
      // Defer to the next tick so content that mounts alongside `active` flipping to
      // true (e.g. a portal's children) is in the DOM before we search it.
      const id = window.setTimeout(() => {
        if (initialFocusRef?.current) {
          initialFocusRef.current.focus();
        } else {
          focusFirst(container);
        }
      }, 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
    // T-021: `initialFocusRef` is deliberately excluded — it's a ref object, mutable but
    // stable, not a value React needs to re-run this effect for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (!active) return undefined;

    function handleKeyDown(event: KeyboardEvent) {
      if (containerRef.current) {
        trapTabKey(containerRef.current, event);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      restoreFocusRef.current?.focus();
    };
  }, [active]);

  return containerRef;
}
