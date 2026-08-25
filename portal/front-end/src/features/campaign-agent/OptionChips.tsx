/**
 * T-049 — the option chips (architecture.html §14's `.chiprow`).
 *
 * ### Why choices are chips and not free text (implementation note 1)
 *
 * *"The maker cannot type an id, and the model cannot mean one it was not given."* Every chip is
 * built from the server's own option list for **this turn**, and selecting one sends the server's
 * own `optionId` back. There is no input on this screen that accepts an id, so there is nothing to
 * guess at and nothing to enumerate; and because the token is re-resolved against the maker's live
 * scope before it can become a database id (10-AI §3.1), a chip is a convenience on top of a
 * server-side gate rather than the gate itself.
 *
 * ### Version numbers are always visible (implementation note 2)
 *
 * A rule chip's `subtitle` is `RULE_CODE · v3` — minted by `lookup.tool.ts` from the version the
 * maker's country is assigned, which is the same fact the wizard's own rule picker shows next to a
 * rule name (`ComponentRulesStep.tsx`: `v{versionNo}`). The two paths therefore teach the same
 * thing: you are choosing a *version*, not a rule in the abstract.
 *
 * ### Keyboard and screen reader (implementation note 7, TC-16, TC-17)
 *
 * Real `<button>` elements in a `role="group"` with an accessible name, so the group is announced,
 * every chip is reachable with Tab and operable with Enter/Space, and a multi-select chip carries
 * `aria-pressed` so its state is announced rather than merely coloured.
 */
import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import type { AgentOption } from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { MULTI_SELECT_KINDS, type AgentOptionKind } from './useAgentSession';

export interface OptionChipsProps {
  readonly kind: AgentOptionKind;
  readonly options: readonly AgentOption[];
  readonly disabled?: boolean;
  readonly onChoose: (kind: AgentOptionKind, chosen: readonly AgentOption[]) => void;
}

const GROUP_LABEL: Readonly<Record<AgentOptionKind, string>> = {
  merchants: 'Merchants you can choose',
  activities: 'Activities you can choose',
  rules: 'Rules available to your country',
  rewards: 'Rewards available to your country',
};

const CONFIRM_LABEL: Readonly<Record<AgentOptionKind, string>> = {
  merchants: 'Use these merchants',
  activities: 'Use these activities',
  rules: 'Use this rule',
  rewards: 'Use this reward',
};

export function OptionChips({ kind, options, disabled = false, onChoose }: OptionChipsProps) {
  const multiple = MULTI_SELECT_KINDS.includes(kind);
  const [selected, setSelected] = useState<readonly string[]>([]);

  // A new turn offers a new list; a selection carried over from the previous one would be a
  // selection of options that are no longer on screen.
  useEffect(() => {
    setSelected([]);
  }, [options]);

  if (options.length === 0) return null;

  const groupId = `agent-options-${kind}`;

  function toggle(option: AgentOption) {
    if (!multiple) {
      onChoose(kind, [option]);
      return;
    }
    setSelected((current) =>
      current.includes(option.optionId)
        ? current.filter((id) => id !== option.optionId)
        : [...current, option.optionId],
    );
  }

  const chosen = options.filter((option) => selected.includes(option.optionId));

  return (
    <div className="grid gap-2 border-t border-slate-200 px-4 py-3">
      <p id={groupId} className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {GROUP_LABEL[kind]}
      </p>

      <div role="group" aria-labelledby={groupId} className="flex flex-wrap gap-2">
        {options.map((option) => {
          const isSelected = selected.includes(option.optionId);
          return (
            <button
              key={option.optionId}
              type="button"
              disabled={disabled}
              aria-pressed={multiple ? isSelected : undefined}
              onClick={() => {
                toggle(option);
              }}
              className={[
                'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
                'disabled:cursor-not-allowed disabled:opacity-60',
                isSelected
                  ? 'border-primary-600 bg-primary-50 text-primary-800'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
              ].join(' ')}
            >
              {isSelected && <Check className="size-3.5" aria-hidden="true" />}
              <span className="font-medium">{option.label}</span>
              {option.subtitle !== null && option.subtitle !== '' && (
                <span className="text-xs text-slate-500">{option.subtitle}</span>
              )}
            </button>
          );
        })}
      </div>

      {multiple && (
        <div>
          <Button
            type="button"
            size="sm"
            disabled={disabled || chosen.length === 0}
            onClick={() => {
              onChoose(kind, chosen);
            }}
          >
            {CONFIRM_LABEL[kind]}
          </Button>
        </div>
      )}
    </div>
  );
}
