import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { cx } from './internal/cx';
import { useOutsideClick } from './internal/useOutsideClick';
import { useEscapeKey } from './internal/useEscapeKey';

export interface MultiSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface MultiSelectProps {
  label: string;
  hideLabel?: boolean;
  options: MultiSelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
  className?: string;
}

const ITEM_HEIGHT = 36;
const VIEWPORT_HEIGHT = 240;
const OVERSCAN = 4;

/**
 * T-021 TC-13 — filters responsively and stays smooth at 500 options via a hand-rolled
 * windowed render (no `react-window`/`react-virtual` in this workspace — see the T-021
 * completion report). Only the rows intersecting the scrolled viewport (+ a small
 * overscan) are ever mounted; the listbox's total scroll height is preserved with a
 * spacer so scrollbar size/position stay correct.
 */
export function MultiSelect({
  label,
  hideLabel,
  options,
  value,
  onChange,
  placeholder = 'Select…',
  error,
  disabled,
  className,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  const baseId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const errorId = error ? `${baseId}-error` : undefined;

  const filteredOptions = useMemo(
    () => options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase())),
    [options, query],
  );

  useOutsideClick([triggerRef, popoverRef], () => setOpen(false), open);
  useEscapeKey(() => setOpen(false), open);

  function toggleValue(optionValue: string) {
    onChange(
      value.includes(optionValue)
        ? value.filter((v) => v !== optionValue)
        : [...value, optionValue],
    );
  }

  function handleOpen() {
    if (disabled) return;
    setOpen(true);
    setActiveIndex(0);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }

  function moveActive(delta: number) {
    setActiveIndex((current) => {
      const next = Math.min(Math.max(current + delta, 0), Math.max(filteredOptions.length - 1, 0));
      const nextTop = next * ITEM_HEIGHT;
      const container = popoverRef.current?.querySelector<HTMLDivElement>(
        '[data-multiselect-scroll]',
      );
      if (container) {
        if (nextTop < container.scrollTop) container.scrollTop = nextTop;
        else if (nextTop + ITEM_HEIGHT > container.scrollTop + VIEWPORT_HEIGHT) {
          container.scrollTop = nextTop + ITEM_HEIGHT - VIEWPORT_HEIGHT;
        }
      }
      return next;
    });
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Enter': {
        event.preventDefault();
        const option = filteredOptions[activeIndex];
        if (option && !option.disabled) toggleValue(option.value);
        break;
      }
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  }

  const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ITEM_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(filteredOptions.length, startIndex + visibleCount);
  const visibleOptions = filteredOptions.slice(startIndex, endIndex);

  const summary = value.length === 0 ? placeholder : `${value.length} selected`;

  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label
        id={`${baseId}-label`}
        htmlFor={baseId}
        className={cx('text-sm font-medium text-slate-700', hideLabel && 'sr-only')}
      >
        {label}
      </label>
      <div className="relative">
        <button
          ref={triggerRef}
          id={baseId}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={`${baseId}-listbox`}
          aria-labelledby={`${baseId}-label ${baseId}`}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={errorId}
          disabled={disabled}
          onClick={() => (open ? setOpen(false) : handleOpen())}
          className={cx(
            'flex h-10 w-full items-center justify-between rounded-control border border-slate-300 bg-white px-3 text-sm',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
            'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400',
            error && 'border-danger-500',
          )}
        >
          <span className={cx(value.length === 0 && 'text-slate-400')}>{summary}</span>
          <ChevronDown className="size-4 text-slate-400" aria-hidden="true" />
        </button>
        {open && (
          <div
            ref={popoverRef}
            className="absolute z-20 mt-1 w-full rounded-control border border-slate-200 bg-white shadow-popover"
          >
            <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
              <Search className="size-4 shrink-0 text-slate-400" aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder="Filter options"
                aria-label="Filter options"
                aria-controls={`${baseId}-listbox`}
                aria-activedescendant={
                  filteredOptions[activeIndex]
                    ? `${baseId}-option-${filteredOptions[activeIndex].value}`
                    : undefined
                }
                className="w-full text-sm outline-none placeholder:text-slate-400"
              />
              {query && (
                <button type="button" aria-label="Clear filter" onClick={() => setQuery('')}>
                  <X className="size-3.5 text-slate-400" aria-hidden="true" />
                </button>
              )}
            </div>
            <div
              data-multiselect-scroll
              role="listbox"
              id={`${baseId}-listbox`}
              aria-multiselectable="true"
              aria-labelledby={`${baseId}-label`}
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
              style={{ height: VIEWPORT_HEIGHT, overflowY: 'auto' }}
            >
              {filteredOptions.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-slate-400">
                  No options match "{query}"
                </p>
              ) : (
                <div style={{ height: filteredOptions.length * ITEM_HEIGHT, position: 'relative' }}>
                  {visibleOptions.map((option, offset) => {
                    const index = startIndex + offset;
                    const selected = value.includes(option.value);
                    const active = index === activeIndex;
                    return (
                      <div
                        key={option.value}
                        id={`${baseId}-option-${option.value}`}
                        role="option"
                        aria-selected={selected}
                        aria-disabled={option.disabled || undefined}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => !option.disabled && toggleValue(option.value)}
                        style={{
                          position: 'absolute',
                          top: index * ITEM_HEIGHT,
                          height: ITEM_HEIGHT,
                        }}
                        className={cx(
                          'flex w-full cursor-pointer items-center justify-between px-3 text-sm',
                          active && 'bg-primary-50',
                          option.disabled && 'cursor-not-allowed text-slate-300',
                        )}
                      >
                        {option.label}
                        {selected && (
                          <Check className="size-4 text-primary-600" aria-hidden="true" />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-danger-600">
          {error}
        </p>
      )}
    </div>
  );
}
