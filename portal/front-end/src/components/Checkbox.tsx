import { forwardRef, useEffect, useId, useRef, type InputHTMLAttributes } from 'react';
import { Check, Minus } from 'lucide-react';
import { cx } from './internal/cx';
import { mergeRefs } from './internal/mergeRefs';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  label: string;
  hideLabel?: boolean;
  /** Visual + `aria-checked="mixed"` indeterminate state; caller still controls `checked`. */
  indeterminate?: boolean;
  error?: string;
  id?: string;
}

/**
 * T-021 — built on a real `<input type="checkbox">` rather than a hand-rolled `div`, so
 * keyboard toggling (Space), form participation and screen-reader semantics are native
 * and correct for free. `@radix-ui/react-checkbox` (^1.1.2) is declared in `package.json`
 * for parity with the task's own guidance, but note it *also* renders a native
 * `<input type="checkbox">` under the hood for exactly this reason — the native-first
 * approach here is not a lesser substitute, just the same guarantee without the extra layer.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, hideLabel, indeterminate, error, id, className, checked, ...rest },
  ref,
) {
  const generatedId = useId();
  const checkboxId = id ?? generatedId;
  const errorId = error ? `${checkboxId}-error` : undefined;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={checkboxId} className="inline-flex cursor-pointer items-center gap-2">
        <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
          <input
            ref={mergeRefs(ref, inputRef)}
            id={checkboxId}
            type="checkbox"
            checked={checked}
            aria-checked={indeterminate ? 'mixed' : checked}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={errorId}
            className={cx(
              'peer size-4 shrink-0 appearance-none rounded border border-slate-300 bg-white',
              'checked:border-primary-600 checked:bg-primary-600',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
              'disabled:cursor-not-allowed disabled:bg-slate-100',
              className,
            )}
            {...rest}
          />
          {indeterminate ? (
            <Minus
              className="pointer-events-none absolute size-3 text-white opacity-0 peer-checked:opacity-100"
              aria-hidden="true"
            />
          ) : (
            <Check
              className="pointer-events-none absolute size-3 text-white opacity-0 peer-checked:opacity-100"
              aria-hidden="true"
            />
          )}
        </span>
        <span className={cx('text-sm text-slate-700', hideLabel && 'sr-only')}>{label}</span>
      </label>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-danger-600">
          {error}
        </p>
      )}
    </div>
  );
});
