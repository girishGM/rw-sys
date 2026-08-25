import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cx } from './internal/cx';
import { useOutsideClick } from './internal/useOutsideClick';
import { useEscapeKey } from './internal/useEscapeKey';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  label: string;
  hideLabel?: boolean;
  options: SelectOption[];
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * T-021 — WAI-ARIA 1.2 "Select Only" combobox pattern (non-editable trigger + listbox
 * popup). `@radix-ui/react-select` (^2.1.2) is declared in `package.json` as the recommended
 * follow-up swap once network access exists in this sandbox (see the T-021 completion
 * report, "Deviations from spec") — this hand-rolls the same contract: `ArrowUp`/`ArrowDown` move
 * the active option, typeahead jumps to a matching label, `Enter`/`Space` selects and
 * closes, `Escape` closes without changing the value, focus never leaves the trigger.
 */
export function Select({
  label,
  hideLabel,
  options,
  value,
  onChange,
  placeholder = 'Select…',
  error,
  disabled,
  className,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const typeaheadRef = useRef('');
  const typeaheadTimer = useRef<number>();

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const selectedIndex = options.findIndex((o) => o.value === value);
  const selectedOption = options.find((o) => o.value === value);
  const errorId = error ? `${baseId}-error` : undefined;

  useOutsideClick([triggerRef, listRef], () => setOpen(false), open);
  useEscapeKey(() => setOpen(false), open);

  function openAt(index: number) {
    setActiveIndex(Math.max(0, index));
    setOpen(true);
  }

  function commit(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveActive(delta: number) {
    setActiveIndex((current) => {
      let next = current;
      for (let i = 0; i < options.length; i += 1) {
        next = (next + delta + options.length) % options.length;
        if (!options[next].disabled) return next;
      }
      return current;
    });
  }

  function handleTypeahead(key: string) {
    window.clearTimeout(typeaheadTimer.current);
    typeaheadRef.current += key.toLowerCase();
    const match = options.findIndex((o) => o.label.toLowerCase().startsWith(typeaheadRef.current));
    if (match >= 0) setActiveIndex(match);
    typeaheadTimer.current = window.setTimeout(() => {
      typeaheadRef.current = '';
    }, 500);
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openAt(selectedIndex >= 0 ? selectedIndex : 0);
      }
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        commit(activeIndex);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        if (event.key.length === 1) handleTypeahead(event.key);
    }
  }

  const activeId = open ? `${baseId}-option-${activeIndex}` : undefined;

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
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={`${baseId}-listbox`}
          aria-labelledby={`${baseId}-label ${baseId}`}
          aria-activedescendant={activeId}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={errorId}
          disabled={disabled}
          onClick={() => (open ? setOpen(false) : openAt(selectedIndex >= 0 ? selectedIndex : 0))}
          onKeyDown={handleTriggerKeyDown}
          className={cx(
            'flex h-10 w-full items-center justify-between rounded-control border border-slate-300 bg-white px-3 text-sm',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
            'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400',
            error && 'border-danger-500',
          )}
        >
          <span className={cx(!selectedOption && 'text-slate-400')}>
            {selectedOption ? selectedOption.label : placeholder}
          </span>
          <ChevronDown className="size-4 text-slate-400" aria-hidden="true" />
        </button>
        {open && (
          <ul
            ref={listRef}
            id={`${baseId}-listbox`}
            role="listbox"
            aria-labelledby={`${baseId}-label`}
            className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-control border border-slate-200 bg-white py-1 shadow-popover"
          >
            {options.map((option, index) => {
              const selected = option.value === value;
              const active = index === activeIndex;
              return (
                <li
                  key={option.value}
                  id={`${baseId}-option-${index}`}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={option.disabled || undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => commit(index)}
                  className={cx(
                    'flex cursor-pointer items-center justify-between px-3 py-2 text-sm',
                    active && 'bg-primary-50',
                    option.disabled && 'cursor-not-allowed text-slate-300',
                  )}
                >
                  {option.label}
                  {selected && <Check className="size-4 text-primary-600" aria-hidden="true" />}
                </li>
              );
            })}
          </ul>
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
