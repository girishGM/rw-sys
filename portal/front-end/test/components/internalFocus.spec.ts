import { describe, expect, it } from 'vitest';
import { focusFirst, getFocusableElements, trapTabKey } from '../../src/components/internal/focus';

function makeContainer(html: string): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

describe('internal/focus', () => {
  it('getFocusableElements finds native interactive elements but skips hidden/disabled ones', () => {
    const container = makeContainer(`
      <button>First</button>
      <button disabled>Disabled</button>
      <button hidden>Hidden attr</button>
      <button style="display:none">Display none</button>
      <a href="/x">Link</a>
      <span tabindex="-1">Not tabbable</span>
      <input />
    `);
    const focusable = getFocusableElements(container);
    expect(focusable.map((el) => el.textContent || el.tagName)).toEqual(['First', 'Link', 'INPUT']);
  });

  it('focusFirst focuses the first focusable descendant', () => {
    const container = makeContainer(`<button>First</button><button>Second</button>`);
    focusFirst(container);
    expect(document.activeElement?.textContent).toBe('First');
  });

  it('focusFirst falls back to the container itself when nothing is focusable', () => {
    const container = makeContainer(`<span>Just text</span>`);
    container.tabIndex = -1;
    focusFirst(container);
    expect(document.activeElement).toBe(container);
  });

  it('trapTabKey wraps Tab from the last element back to the first', () => {
    const container = makeContainer(`<button>First</button><button>Second</button>`);
    const [first, second] = getFocusableElements(container);
    second.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    trapTabKey(container, event);
    expect(document.activeElement).toBe(first);
    expect(event.defaultPrevented).toBe(true);
  });

  it('trapTabKey wraps Shift+Tab from the first element back to the last', () => {
    const container = makeContainer(`<button>First</button><button>Second</button>`);
    const [first, second] = getFocusableElements(container);
    first.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true });
    trapTabKey(container, event);
    expect(document.activeElement).toBe(second);
  });

  it('trapTabKey ignores non-Tab keys', () => {
    const container = makeContainer(`<button>First</button>`);
    const [first] = getFocusableElements(container);
    first.focus();
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    trapTabKey(container, event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('trapTabKey prevents Tab entirely when the container has nothing focusable', () => {
    const container = makeContainer(`<span>No controls</span>`);
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    trapTabKey(container, event);
    expect(event.defaultPrevented).toBe(true);
  });
});
