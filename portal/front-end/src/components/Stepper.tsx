import { Check } from 'lucide-react';
import { cx } from './internal/cx';

export interface StepperStep {
  label: string;
  description?: string;
}

export interface StepperProps {
  steps: StepperStep[];
  /** Zero-based index of the active step. */
  currentStep: number;
  className?: string;
}

/**
 * T-021 TC-14 — the active step carries `aria-current="step"`; steps before it are marked
 * complete both visually (check icon) and in the accessible name (", completed").
 */
export function Stepper({ steps, currentStep, className }: StepperProps) {
  return (
    <ol className={cx('flex w-full items-start', className)}>
      {steps.map((step, index) => {
        const isComplete = index < currentStep;
        const isCurrent = index === currentStep;
        return (
          <li
            key={step.label}
            aria-current={isCurrent ? 'step' : undefined}
            className={cx(
              'flex flex-1 flex-col items-center gap-1 text-center',
              index === 0 && 'items-start text-left',
            )}
          >
            <div className="flex w-full items-center">
              {index > 0 && (
                <span
                  aria-hidden="true"
                  className={cx(
                    'h-px flex-1',
                    isComplete || isCurrent ? 'bg-primary-600' : 'bg-slate-200',
                  )}
                />
              )}
              <span
                className={cx(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                  isComplete && 'bg-primary-600 text-white',
                  isCurrent && 'border-2 border-primary-600 text-primary-700',
                  !isComplete && !isCurrent && 'border border-slate-300 text-slate-400',
                )}
              >
                {isComplete ? <Check className="size-3.5" aria-hidden="true" /> : index + 1}
              </span>
            </div>
            <span
              className={cx(
                'text-xs font-medium',
                isCurrent ? 'text-primary-700' : 'text-slate-600',
              )}
            >
              {step.label}
              {isComplete && <span className="sr-only">, completed</span>}
              {isCurrent && <span className="sr-only">, current step</span>}
            </span>
            {step.description && <span className="text-xs text-slate-400">{step.description}</span>}
          </li>
        );
      })}
    </ol>
  );
}
