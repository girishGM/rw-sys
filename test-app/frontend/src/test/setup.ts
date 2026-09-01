import '@testing-library/jest-dom';

// T-006 — jsdom implements neither `ResizeObserver` nor pointer-capture/`scrollIntoView`, all of
// which `@radix-ui/react-select` (CustomerSwitcher) and `@radix-ui/react-dialog` (Nav's mobile
// drawer) rely on internally; every future Radix-based component needs the same polyfills, so
// they're installed once, globally, here rather than duplicated per test file.
if (typeof window !== 'undefined') {
  if (!window.ResizeObserver) {
    class ResizeObserverPolyfill {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    window.ResizeObserver = ResizeObserverPolyfill as unknown as typeof ResizeObserver;
  }

  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}
