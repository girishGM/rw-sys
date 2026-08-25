import { forwardRef, useId } from 'react';
import { cx } from './internal/cx';

export interface ToggleProps {
  label: string;
  hideLabel?: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * T-021 — WAI-ARIA "switch" pattern: `<button role="switch" aria-checked>`, toggled by
 * click or `Space`/`Enter` (native `<button>` behaviour, no extra key handling needed).
 * `@radix-ui/react-switch` (^1.1.1) is declared in `package.json` as the recommended
 * follow-up swap once network access exists in this sandbox.
 */
export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { label, hideLabel, checked, onChange, disabled, id, className },
  ref,
) {
  const generatedId = useId();
  const toggleId = id ?? generatedId;

  return (
    <label htmlFor={toggleId} className="inline-flex cursor-pointer items-center gap-2">
      <button
        ref={ref}
        id={toggleId}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
          checked ? 'bg-primary-600' : 'bg-slate-300',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            'inline-block size-4 transform rounded-full bg-white transition-transform',
            checked ? 'translate-x-6' : 'translate-x-1',
          )}
        />
      </button>
      <span className={cx('text-sm text-slate-700', hideLabel && 'sr-only')}>{label}</span>
    </label>
  );
});
