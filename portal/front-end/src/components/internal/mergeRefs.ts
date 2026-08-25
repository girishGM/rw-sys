import type { MutableRefObject, Ref } from 'react';

/** Combines multiple refs (forwarded + internal) into one ref callback. */
export function mergeRefs<T>(...refs: (Ref<T> | undefined)[]) {
  return (node: T | null) => {
    refs.forEach((ref) => {
      if (!ref) return;
      if (typeof ref === 'function') {
        ref(node);
      } else {
        (ref as MutableRefObject<T | null>).current = node;
      }
    });
  };
}
