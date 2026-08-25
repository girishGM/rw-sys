import { useEffect, useId, useRef } from 'react';

/**
 * Stack of currently-active `useEscapeKey` instances, most-recently-activated last.
 *
 * T-075: `Modal`, `MultiSelect`, `Select`, `DatePicker`, `Drawer` and `ConfirmDialog` each
 * call this hook independently, and any of them can be layered on top of another (e.g. a
 * `MultiSelect` dropdown open inside a `Modal`). Previously each instance registered its own
 * unconditional `document` `keydown` listener, so one `Escape` press fired *every* active
 * instance at once — closing the outer dialog and discarding whatever was in progress in the
 * inner one, instead of closing just the top-most layer. Tracking activation order here and
 * only invoking the top-of-stack instance's `onEscape` reproduces the browser-native
 * top-layer behaviour (like `<dialog>`/`popover`) without requiring every caller to coordinate
 * z-index or manually `stopPropagation`.
 */
const activeStack: string[] = [];

/**
 * Calls `onEscape` when `Escape` is pressed anywhere while `active` — but only for the
 * most-recently-activated instance currently on the stack. An outer, already-active instance
 * (e.g. an open `Modal`) is skipped for a given keypress while a later-activated inner one
 * (e.g. its `MultiSelect` dropdown) is on top; once the inner one deactivates, the outer one
 * resumes handling `Escape` on the next press.
 */
export function useEscapeKey(onEscape: () => void, active = true): void {
  const id = useId();
  // Keep the latest callback in a ref so the listener doesn't need to be torn down and
  // rebuilt purely because the caller passed a new function identity this render.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return undefined;
    activeStack.push(id);

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (activeStack[activeStack.length - 1] !== id) return;
      onEscapeRef.current();
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const index = activeStack.indexOf(id);
      if (index !== -1) activeStack.splice(index, 1);
    };
  }, [active, id]);
}
