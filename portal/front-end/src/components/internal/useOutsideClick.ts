import { useEffect, type RefObject } from 'react';

/** Fires `onOutside` for any pointerdown outside every ref in `refs` while `active`. */
export function useOutsideClick(
  refs: RefObject<HTMLElement>[],
  onOutside: () => void,
  active = true,
): void {
  useEffect(() => {
    if (!active) return undefined;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      const inside = refs.some((ref) => ref.current?.contains(target));
      if (!inside) onOutside();
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
    // T-021: `refs` (array of ref objects) is deliberately excluded — ref objects are
    // stable, and a fresh array literal from the caller on every render would otherwise
    // re-run this effect (re-attaching the same listener) on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, onOutside]);
}
