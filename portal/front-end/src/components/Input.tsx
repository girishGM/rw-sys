import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import { cx } from './internal/cx';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  /** Visually hides `label` while keeping it in the accessibility tree. */
  hideLabel?: boolean;
  error?: string;
  hint?: string;
  id?: string;
  containerClassName?: string;
}

/**
 * T-021 — every input carries its own `<label>` (DoD: "every input labelled"), and wires
 * `aria-invalid`/`aria-describedby` to `error`/`hint` so assistive tech announces both.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hideLabel, error, hint, id, className, containerClassName, ...rest },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div className={cx('flex flex-col gap-1.5', containerClassName)}>
      <label
        htmlFor={inputId}
        className={cx('text-sm font-medium text-slate-700', hideLabel && 'sr-only')}
      >
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={cx(hintId, errorId) || undefined}
        className={cx(
          'h-10 rounded-control border border-slate-300 bg-white px-3 text-sm text-slate-900',
          'placeholder:text-slate-400',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
          'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400',
          error && 'border-danger-500',
          className,
        )}
        {...rest}
      />
      {hint && !error && (
        <p id={hintId} className="text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-danger-600">
          {error}
        </p>
      )}
    </div>
  );
});
