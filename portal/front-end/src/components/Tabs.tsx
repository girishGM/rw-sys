import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './internal/cx';

export interface TabItem {
  value: string;
  label: string;
  disabled?: boolean;
  panel: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

/**
 * T-021 — WAI-ARIA "tabs" pattern: one `tab` is in the Tab order (roving `tabindex`),
 * `ArrowLeft`/`ArrowRight`/`Home`/`End` move selection between tabs, matching `tabpanel`
 * is exposed via `aria-controls`/`aria-labelledby`. `@radix-ui/react-tabs` (^1.1.1) is
 * declared in `package.json` as the recommended follow-up swap once network access exists.
 */
export function Tabs({ items, value, onChange, className }: TabsProps) {
  const baseId = useId();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const enabled = items.filter((item) => !item.disabled);

  function focusAndSelect(nextValue: string) {
    onChange(nextValue);
    tabRefs.current[nextValue]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = enabled.findIndex((item) => item.value === value);
    if (currentIndex === -1) return;

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusAndSelect(enabled[(currentIndex + 1) % enabled.length].value);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusAndSelect(enabled[(currentIndex - 1 + enabled.length) % enabled.length].value);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusAndSelect(enabled[0].value);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusAndSelect(enabled[enabled.length - 1].value);
    }
  }

  const activeItem = items.find((item) => item.value === value);

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-orientation="horizontal"
        onKeyDown={handleKeyDown}
        className="flex gap-1 border-b border-slate-200"
      >
        {items.map((item) => {
          const tabId = `${baseId}-tab-${item.value}`;
          const panelId = `${baseId}-panel-${item.value}`;
          const selected = item.value === value;
          return (
            <button
              key={item.value}
              ref={(el) => {
                tabRefs.current[item.value] = el;
              }}
              id={tabId}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={panelId}
              disabled={item.disabled}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(item.value)}
              className={cx(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
                selected
                  ? 'border-primary-600 text-primary-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700',
                item.disabled && 'cursor-not-allowed text-slate-300 hover:text-slate-300',
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {activeItem && (
        <div
          id={`${baseId}-panel-${activeItem.value}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${activeItem.value}`}
          tabIndex={0}
          className="pt-4 focus-visible:outline-none"
        >
          {activeItem.panel}
        </div>
      )}
    </div>
  );
}
