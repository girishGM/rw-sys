import { useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  addDays,
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isValid,
  parse,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { cx } from './internal/cx';
import { useOutsideClick } from './internal/useOutsideClick';
import { useEscapeKey } from './internal/useEscapeKey';

const DATE_FORMAT = 'yyyy-MM-dd';
const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export interface DatePickerProps {
  label: string;
  hideLabel?: boolean;
  /** `null` means empty/unset. */
  value: Date | null;
  onChange: (date: Date | null) => void;
  error?: string;
  disabled?: boolean;
  min?: Date;
  max?: Date;
  className?: string;
}

/**
 * T-021 TC-12 — a plain-text field (typed input parses via `date-fns`, invalid text shows
 * an inline error) plus an optional calendar popup for pointer/keyboard-grid selection. No
 * Radix/react-day-picker dependency available in this workspace (T-021 completion report).
 * The calendar grid follows the WAI-ARIA APG "Date Picker Dialog" shape: `role="grid"`,
 * roving `tabIndex` across day cells, arrow keys move by day/week, `PageUp`/`PageDown`
 * move by month, `Enter`/`Space` selects, `Escape` closes.
 */
export function DatePicker({
  label,
  hideLabel,
  value,
  onChange,
  error: externalError,
  disabled,
  min,
  max,
  className,
}: DatePickerProps) {
  const [text, setText] = useState(value ? format(value, DATE_FORMAT) : '');
  const [parseError, setParseError] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [focusedDate, setFocusedDate] = useState(value ?? new Date());

  const baseId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const error = externalError ?? parseError;
  const errorId = error ? `${baseId}-error` : undefined;

  useOutsideClick([inputRef, popoverRef], () => setOpen(false), open);
  useEscapeKey(() => setOpen(false), open);

  function commitText(raw: string) {
    if (raw.trim() === '') {
      setParseError(undefined);
      onChange(null);
      return;
    }
    const parsed = parse(raw, DATE_FORMAT, new Date());
    if (!isValid(parsed)) {
      setParseError(`Enter a valid date (${DATE_FORMAT.toUpperCase()})`);
      return;
    }
    setParseError(undefined);
    setFocusedDate(parsed);
    onChange(parsed);
  }

  function selectDate(date: Date) {
    setText(format(date, DATE_FORMAT));
    setParseError(undefined);
    onChange(date);
    setOpen(false);
    inputRef.current?.focus();
  }

  function focusGridDay(next: Date, focusAfter = true) {
    setFocusedDate(next);
    if (focusAfter) {
      window.setTimeout(() => {
        gridRef.current
          ?.querySelector<HTMLButtonElement>(`[data-day="${format(next, DATE_FORMAT)}"]`)
          ?.focus();
      }, 0);
    }
  }

  function handleGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keyToDelta: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: 7,
      ArrowUp: -7,
    };
    if (event.key in keyToDelta) {
      event.preventDefault();
      focusGridDay(addDays(focusedDate, keyToDelta[event.key]));
    } else if (event.key === 'PageDown') {
      event.preventDefault();
      focusGridDay(addMonths(focusedDate, 1));
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      focusGridDay(subMonths(focusedDate, 1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectDate(focusedDate);
    }
  }

  const monthStart = startOfMonth(focusedDate);
  const gridStart = startOfWeek(monthStart);
  const gridEnd = endOfWeek(endOfMonth(focusedDate));
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });

  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={baseId}
        className={cx('text-sm font-medium text-slate-700', hideLabel && 'sr-only')}
      >
        {label}
      </label>
      <div className="relative">
        <div className="relative">
          <input
            ref={inputRef}
            id={baseId}
            type="text"
            inputMode="numeric"
            placeholder={DATE_FORMAT}
            value={text}
            disabled={disabled}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={errorId}
            onChange={(event) => setText(event.target.value)}
            onBlur={(event) => commitText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitText(text);
            }}
            className={cx(
              'h-10 w-full rounded-control border border-slate-300 bg-white pl-3 pr-9 text-sm text-slate-900',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
              'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400',
              error && 'border-danger-500',
            )}
          />
          <button
            type="button"
            aria-label="Open calendar"
            disabled={disabled}
            onClick={() => setOpen((current) => !current)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
          >
            <CalendarDays className="size-4" aria-hidden="true" />
          </button>
        </div>
        {open && (
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Choose date"
            className="absolute z-20 mt-1 w-72 rounded-control border border-slate-200 bg-white p-3 shadow-popover"
          >
            <div className="mb-2 flex items-center justify-between">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => focusGridDay(subMonths(focusedDate, 1), false)}
                className="rounded-control p-1 hover:bg-slate-100"
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </button>
              <span className="text-sm font-medium text-slate-900">
                {format(focusedDate, 'MMMM yyyy')}
              </span>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => focusGridDay(addMonths(focusedDate, 1), false)}
                className="rounded-control p-1 hover:bg-slate-100"
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-1 text-center text-xs text-slate-400">
              {WEEKDAY_LABELS.map((weekday) => (
                <span key={weekday} aria-hidden="true">
                  {weekday}
                </span>
              ))}
            </div>
            <div
              ref={gridRef}
              role="grid"
              aria-label={format(focusedDate, 'MMMM yyyy')}
              onKeyDown={handleGridKeyDown}
            >
              <div className="grid grid-cols-7 gap-1">
                {days.map((day) => {
                  const inMonth = isSameMonth(day, focusedDate);
                  const isSelected = value ? isSameDay(day, value) : false;
                  const isFocusTarget = isSameDay(day, focusedDate);
                  const isDisabled = (min && day < min) || (max && day > max);
                  return (
                    <button
                      key={day.toISOString()}
                      type="button"
                      role="gridcell"
                      data-day={format(day, DATE_FORMAT)}
                      aria-selected={isSelected}
                      aria-current={isSameDay(day, new Date()) ? 'date' : undefined}
                      disabled={Boolean(isDisabled)}
                      tabIndex={isFocusTarget ? 0 : -1}
                      onClick={() => selectDate(day)}
                      className={cx(
                        'flex size-8 items-center justify-center rounded-control text-sm',
                        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
                        !inMonth && 'text-slate-300',
                        inMonth && !isSelected && 'text-slate-700 hover:bg-slate-100',
                        isSelected && 'bg-primary-600 text-white hover:bg-primary-600',
                        isDisabled && 'cursor-not-allowed text-slate-200 hover:bg-transparent',
                      )}
                    >
                      {format(day, 'd')}
                    </button>
                  );
                })}
              </div>
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
