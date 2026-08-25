/**
 * T-021 — focus-management primitives shared by `Modal`, `Drawer` and `ConfirmDialog`.
 *
 * No dependency on Radix's `FocusScope`/`focus-trap-react` — neither is installed in this
 * workspace (see the T-021 completion report, "Deviations from spec"). This is a small,
 * deliberate hand-rolled implementation of the same WAI-ARIA APG "modal dialog" focus
 * contract: focus moves inside on open, `Tab`/`Shift+Tab` cycle within the dialog only,
 * and focus returns to the trigger on close.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  // Deliberately not filtering on `offsetParent`/`getBoundingClientRect` for "is it
  // visually hidden" — those are layout-engine reads that jsdom (no layout engine) always
  // reports as empty, which would make this function (and every consumer: `Modal`,
  // `Drawer`, `ConfirmDialog`'s focus trap) silently find nothing under Vitest. The
  // `hidden` attribute and inline `display: none` are still real, DOM-only signals, so
  // they're excluded; components in this design system never `visibility: hidden` a
  // dialog's own interactive children, so that gap is accepted.
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hidden && el.style.display !== 'none',
  );
}

/** Moves focus to the first focusable descendant, or the container itself as a fallback. */
export function focusFirst(container: HTMLElement): void {
  const [first] = getFocusableElements(container);
  if (first) {
    first.focus();
  } else {
    container.focus();
  }
}

/**
 * Keydown handler factory implementing Tab-cycling within `container`. Attach to a
 * `keydown` listener on the trapping container; call on every keydown, it no-ops for
 * anything other than `Tab`.
 */
export function trapTabKey(container: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== 'Tab') return;
  const focusable = getFocusableElements(container);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey) {
    if (active === first || !container.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last || !container.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}
