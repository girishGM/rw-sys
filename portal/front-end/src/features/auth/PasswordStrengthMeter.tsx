/**
 * T-024 — real-time feedback for the two policy rules `passwordPolicy.ts` can honestly check
 * client-side (see that file's banner for the three it cannot). Pairs colour with **text** for
 * every state (04-FRONTEND.md §7: "Status colours... always paired with text, never colour
 * alone", WCAG 1.4.1) and marks each requirement's pass/fail state in an `sr-only` suffix so
 * assistive tech gets the same information a sighted user reads from the icon.
 */
import { Check, X } from 'lucide-react';
import { cx } from '../../components/internal/cx';
import {
  PASSWORD_MIN_CHARACTER_CLASSES,
  PASSWORD_MIN_LENGTH,
  passwordHasEnoughCharacterClasses,
  passwordMeetsLengthRequirement,
} from './passwordPolicy';

export interface PasswordStrengthMeterProps {
  password: string;
  className?: string;
}

interface Requirement {
  readonly key: string;
  readonly label: string;
  readonly met: boolean;
}

const BAR_TONE = ['bg-danger-500', 'bg-warning-500', 'bg-success-600'];
const LABEL = ['Weak', 'Fair', 'Strong'];

export function PasswordStrengthMeter({ password, className }: PasswordStrengthMeterProps) {
  const requirements: Requirement[] = [
    {
      key: 'length',
      label: `At least ${PASSWORD_MIN_LENGTH} characters`,
      met: passwordMeetsLengthRequirement(password),
    },
    {
      key: 'classes',
      label: `At least ${PASSWORD_MIN_CHARACTER_CLASSES} of: lowercase, uppercase, numbers, symbols`,
      met: passwordHasEnoughCharacterClasses(password),
    },
  ];
  const metCount = requirements.filter((requirement) => requirement.met).length;
  const hasInput = password.length > 0;
  const toneIndex = hasInput ? metCount : 0;

  return (
    <div className={cx('flex flex-col gap-2', className)}>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
          <div
            className={cx('h-full rounded-full transition-all', BAR_TONE[toneIndex])}
            style={{ width: hasInput ? `${(metCount / requirements.length) * 100}%` : '0%' }}
          />
        </div>
        <span className="w-14 shrink-0 text-xs font-medium text-slate-600">
          {hasInput ? LABEL[toneIndex] : ''}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {requirements.map((requirement) => (
          <li key={requirement.key} className="flex items-center gap-1.5 text-xs text-slate-600">
            {requirement.met ? (
              <Check className="size-3.5 shrink-0 text-success-600" aria-hidden="true" />
            ) : (
              <X className="size-3.5 shrink-0 text-slate-400" aria-hidden="true" />
            )}
            <span>
              {requirement.label}
              <span className="sr-only">{requirement.met ? ' — met' : ' — not met'}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
