/**
 * T-010 — the Activity Simulator's form: real, functional Radix `Select` for activity type
 * (options come from `useActivityTypeOptions`, this task's Scope: "not the mockup's static
 * placeholders") + real text/number inputs for merchant/amount, submitting to
 * `POST /api/activities` via the caller's `onSubmit`. Merchant stays a free-text input rather than
 * a `Select` — `tracking-service`'s `portal-client` never exposes a merchant list (only
 * campaigns/journeys, see `ARCHITECTURE.md` §3), so there is no real merchant data this page could
 * honestly populate a dropdown from; a hardcoded merchant list would be exactly the "possibly-stale
 * list" this task's Scope says to avoid. Activity type, by contrast, has a real source
 * (`CampaignDetailComponent.activityName`), so that one is a genuine `Select`.
 *
 * TC-8 (rapid double-submit): the submit button is `disabled` whenever `isSubmitting` is true —
 * the caller (`ActivitySimulatorPage`) passes `postActivity.isPending` straight through, so a
 * second click while the first request is still in flight is a no-op, not a second POST.
 */
import { useState, type FormEvent } from 'react';
import * as Select from '@radix-ui/react-select';
import { Card } from '../../components/Card';
import { CheckCircleIcon, ChevronDownIcon, ZapIcon } from '../../components/icons';

export interface ActivitySubmitValues {
  readonly activityType: string;
  readonly merchant?: string;
  readonly amount?: number;
}

export interface ActivityFormProps {
  readonly activityTypeOptions: readonly string[];
  readonly optionsLoading: boolean;
  readonly isSubmitting: boolean;
  readonly onSubmit: (values: ActivitySubmitValues) => void;
}

const LABEL_CLASS = 'font-body text-xs font-semibold uppercase tracking-wide text-ink-muted';
const FIELD_CLASS =
  'glass h-11 rounded-chip px-3 text-sm text-ink outline-none placeholder:text-ink-muted focus:ring-2 focus:ring-accent';

export function ActivityForm({
  activityTypeOptions,
  optionsLoading,
  isSubmitting,
  onSubmit,
}: ActivityFormProps) {
  const [activityType, setActivityType] = useState('');
  const [merchant, setMerchant] = useState('');
  const [amount, setAmount] = useState('');

  const canSubmit = activityType.length > 0 && !isSubmitting;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    const trimmedMerchant = merchant.trim();
    const parsedAmount = amount.trim().length > 0 ? Number(amount) : null;

    onSubmit({
      activityType,
      merchant: trimmedMerchant.length > 0 ? trimmedMerchant : undefined,
      amount: parsedAmount !== null && Number.isFinite(parsedAmount) ? parsedAmount : undefined,
    });
  }

  return (
    <Card className="flex flex-col gap-5 p-6">
      <div>
        <h2 className="font-heading text-lg font-bold text-ink">Fire an activity</h2>
        <p className="font-body text-sm text-ink-muted">
          Simulate a real customer action and watch it flow into tracker progress live.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="activity-type" className={LABEL_CLASS}>
            Activity type
          </label>
          <Select.Root
            value={activityType}
            onValueChange={setActivityType}
            disabled={optionsLoading || activityTypeOptions.length === 0}
          >
            {/* T-011: same plain-Tab-focus-has-no-visible-ring gap as CustomerSwitcher's own
                trigger — add focus-visible:ring alongside the open-state one. */}
            <Select.Trigger
              id="activity-type"
              aria-label="Activity type"
              className="glass flex h-11 items-center justify-between gap-2 rounded-chip px-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:ring-2 data-[state=open]:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Select.Value
                placeholder={optionsLoading ? 'Loading activity types…' : 'Select an activity type'}
              />
              <Select.Icon asChild>
                <ChevronDownIcon className="h-4 w-4 text-ink-muted" />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content
                className="glass z-50 max-h-64 overflow-hidden rounded-card p-1"
                position="popper"
                sideOffset={8}
              >
                <Select.Viewport>
                  {activityTypeOptions.map((type) => (
                    <Select.Item
                      key={type}
                      value={type}
                      className="flex cursor-pointer items-center gap-2 rounded-chip px-3 py-2 text-sm text-ink outline-none data-[highlighted]:bg-accent-soft"
                    >
                      <Select.ItemText>{type}</Select.ItemText>
                      <Select.ItemIndicator className="ml-auto">
                        <CheckCircleIcon className="h-4 w-4 text-accent" />
                      </Select.ItemIndicator>
                    </Select.Item>
                  ))}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="activity-merchant" className={LABEL_CLASS}>
            Merchant <span className="normal-case text-ink-muted/70">(optional)</span>
          </label>
          <input
            id="activity-merchant"
            type="text"
            value={merchant}
            onChange={(event) => setMerchant(event.target.value)}
            placeholder="e.g. Fresh Mart"
            className={FIELD_CLASS}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="activity-amount" className={LABEL_CLASS}>
            Amount <span className="normal-case text-ink-muted/70">(optional)</span>
          </label>
          <input
            id="activity-amount"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.00"
            className={FIELD_CLASS}
          />
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className="flex h-11 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-accent to-secondary text-sm font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
        >
          <ZapIcon className="h-4 w-4" />
          {isSubmitting ? 'Submitting…' : 'Submit activity'}
        </button>
      </form>
    </Card>
  );
}
