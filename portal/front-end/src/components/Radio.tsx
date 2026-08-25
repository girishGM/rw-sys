import { useId } from 'react';
import { cx } from './internal/cx';

export interface RadioOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface RadioGroupProps {
  name: string;
  label: string;
  options: RadioOption[];
  value: string | null;
  onChange: (value: string) => void;
  error?: string;
  orientation?: 'vertical' | 'horizontal';
  className?: string;
}

/**
 * T-021 — native `<input type="radio">` per option inside a `fieldset`/`legend`, so arrow-key
 * roving between options and form semantics come from the browser, not hand-rolled ARIA.
 * `@radix-ui/react-radio-group` (^1.2.1) is declared in `package.json` for parity with the
 * task's own guidance, though — like `Checkbox` — native radio inputs are arguably already
 * the more robust choice here; swap only if a feature agent hits a real limitation.
 */
export function RadioGroup({
  name,
  label,
  options,
  value,
  onChange,
  error,
  orientation = 'vertical',
  className,
}: RadioGroupProps) {
  const groupId = useId();
  const errorId = error ? `${groupId}-error` : undefined;

  return (
    <fieldset className={cx('flex flex-col gap-2', className)} aria-describedby={errorId}>
      <legend className="text-sm font-medium text-slate-700">{label}</legend>
      <div
        className={cx('flex gap-3', orientation === 'vertical' ? 'flex-col' : 'flex-row flex-wrap')}
      >
        {options.map((option) => {
          const optionId = `${groupId}-${option.value}`;
          return (
            <label
              key={option.value}
              htmlFor={optionId}
              className={cx(
                'inline-flex items-center gap-2 text-sm text-slate-700',
                option.disabled ? 'cursor-not-allowed text-slate-400' : 'cursor-pointer',
              )}
            >
              <input
                id={optionId}
                type="radio"
                name={name}
                value={option.value}
                checked={value === option.value}
                disabled={option.disabled}
                onChange={() => onChange(option.value)}
                className={cx(
                  'size-4 border-slate-300 text-primary-600',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
                )}
              />
              {option.label}
            </label>
          );
        })}
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-danger-600">
          {error}
        </p>
      )}
    </fieldset>
  );
}
