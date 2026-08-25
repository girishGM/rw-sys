/**
 * T-037 step 6 — budgets and limits (11-BUDGETS-AND-LIMITS.md §6, implementation notes 14–17).
 *
 * ### The visual separation is the requirement, not decoration
 *
 * > *"The two concepts are **visually separated** in the UI, because confusing a pooled budget
 * > with a per-customer limit is the expensive mistake here."* (note 14)
 *
 * So budgets and limits are two distinct panels with their own headings and their own plain-
 * English descriptions — *"shared across all customers"* versus *"per individual customer"* —
 * even though they are one table and one request underneath.
 *
 * ### Warnings are shown, never enforced here
 *
 * Every entry in `warnings` comes from the server (`analyseBudgets`), including the ceiling
 * notices, so this screen and the submit gate cannot disagree about whether a budget is over the
 * line. The **only** thing this screen refuses is nothing at all: saving a draft is never blocked
 * (§8.4, TC-21gg). The red ceiling state disables *submission* on step 7, not this step's save.
 */
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type {
  BudgetCeilingStatus,
  CampaignCapInput,
  CampaignCapRow,
  CampaignWarning,
  Journey,
} from '@reward-portal/shared';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Card, CardBody, CardHeader } from '../../../components/Card';
import { Checkbox } from '../../../components/Checkbox';
import { Input } from '../../../components/Input';
import { Select } from '../../../components/Select';

export interface BudgetsStepProps {
  readonly caps: readonly CampaignCapRow[];
  readonly warnings: readonly CampaignWarning[];
  readonly ceilings: readonly BudgetCeilingStatus[];
  readonly journey: Journey | undefined;
  readonly campaignCurrency: string | null;
  readonly disabled?: boolean;
  readonly saving?: boolean;
  readonly serverError?: string;
  readonly onSave: (caps: CampaignCapInput[], confirmCurrencyMismatch: boolean) => void;
}

type Draft = CampaignCapInput & { readonly localId: string };

let draftCounter = 0;
function nextLocalId(): string {
  draftCounter += 1;
  return `cap-${String(draftCounter)}`;
}

/** A draft as the API wants it: everything except the client-only `localId` React keys rows by.
 * Written as an explicit copy rather than a rest-destructure so no variable is introduced only
 * to be discarded. */
function withoutLocalId(draft: Draft): CampaignCapInput {
  const cap: Record<string, unknown> = { ...draft };
  delete cap.localId;
  return cap as unknown as CampaignCapInput;
}

function toDraft(cap: CampaignCapRow): Draft {
  return {
    localId: nextLocalId(),
    capClass: cap.capClass,
    scopeLevel: cap.scopeLevel,
    scopeRefId: cap.scopeRefId,
    periodType: cap.periodType,
    periodValue: cap.periodValue,
    windowStartTime: cap.windowStartTime === null ? null : cap.windowStartTime.slice(0, 5),
    windowEndTime: cap.windowEndTime === null ? null : cap.windowEndTime.slice(0, 5),
    unitType: cap.unitType as CampaignCapInput['unitType'],
    unitCode: cap.unitCode,
    maxTotalAmount: cap.maxTotalAmount,
    maxOccurrences: cap.maxOccurrences,
    maxCustomers: cap.maxCustomers,
    onBreach: cap.onBreach,
    warnAtPercent: cap.warnAtPercent,
  };
}

export function BudgetsStep({
  caps,
  warnings,
  ceilings,
  journey,
  campaignCurrency,
  disabled,
  saving,
  serverError,
  onSave,
}: BudgetsStepProps) {
  const [drafts, setDrafts] = useState<Draft[]>(() => caps.map(toDraft));
  const [confirmMismatch, setConfirmMismatch] = useState(false);

  // Re-seed when the server's set changes underneath us (another tab, or our own save landing).
  useEffect(() => {
    setDrafts(caps.map(toDraft));
  }, [caps]);

  const budgets = drafts.filter((draft) => draft.capClass === 'budget');
  const limits = drafts.filter((draft) => draft.capClass === 'limit');

  function add(capClass: 'budget' | 'limit'): void {
    setDrafts((current) => [
      ...current,
      {
        localId: nextLocalId(),
        capClass,
        scopeLevel: 'campaign',
        scopeRefId: null,
        periodType: 'lifetime',
        unitType: 'currency',
        unitCode: campaignCurrency ?? 'MYR',
        maxTotalAmount: '',
        onBreach: 'reject',
      },
    ]);
  }

  function update(localId: string, patch: Partial<CampaignCapInput>): void {
    setDrafts((current) =>
      current.map((draft) => (draft.localId === localId ? { ...draft, ...patch } : draft)),
    );
  }

  function remove(localId: string): void {
    setDrafts((current) => current.filter((draft) => draft.localId !== localId));
  }

  return (
    <div className="grid gap-5">
      <CeilingPanel ceilings={ceilings} />
      <WarningsPanel warnings={warnings} />

      <CapPanel
        title="Budget — shared across all customers"
        description="A pooled ceiling. Once it is used up, nobody else is paid from it."
        drafts={budgets}
        journey={journey}
        disabled={disabled}
        onAdd={() => {
          add('budget');
        }}
        onUpdate={update}
        onRemove={remove}
      />

      <CapPanel
        title="Limits — per individual customer"
        description="Applies to each customer separately. One customer reaching their limit does not affect anyone else."
        drafts={limits}
        journey={journey}
        disabled={disabled}
        onAdd={() => {
          add('limit');
        }}
        onUpdate={update}
        onRemove={remove}
      />

      {serverError !== undefined && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {serverError}
        </p>
      )}

      <div className="flex items-center gap-4">
        <Button
          type="button"
          isLoading={saving}
          disabled={disabled}
          onClick={() => {
            onSave(drafts.map(withoutLocalId), confirmMismatch);
          }}
        >
          Save budgets and limits
        </Button>
        <Checkbox
          label="I meant to use a currency other than this campaign's"
          checked={confirmMismatch}
          disabled={disabled}
          onChange={(event) => {
            setConfirmMismatch(event.target.checked);
          }}
        />
      </div>
    </div>
  );
}

function CeilingPanel({ ceilings }: { readonly ceilings: readonly BudgetCeilingStatus[] }) {
  if (ceilings.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-semibold text-slate-800">Your tenant&rsquo;s ceiling</h3>
      </CardHeader>
      <CardBody>
        <ul className="grid gap-2 text-sm">
          {ceilings.map((ceiling) => (
            <li key={`${ceiling.unitType}:${ceiling.unitCode}`} className="flex flex-wrap gap-2">
              <span className="text-slate-800">
                {ceiling.unitCode}: {ceiling.campaignBudget}
                {ceiling.maxCampaignBudget !== null && ` of ${ceiling.maxCampaignBudget}`}
              </span>
              {ceiling.state === 'unlimited' && <Badge tone="slate">no ceiling set</Badge>}
              {ceiling.state === 'ok' && <Badge tone="success">{ceiling.headroom} headroom</Badge>}
              {ceiling.state === 'warn' && (
                <Badge tone="warning">{ceiling.percentOfCeiling}% of the ceiling</Badge>
              )}
              {ceiling.state === 'over' && (
                <Badge tone="danger">over the ceiling — this campaign cannot be submitted</Badge>
              )}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

/** Plain-English text for each warning code. The codes themselves are the contract; these
 * sentences are the part a maker acts on. */
const WARNING_TEXT: Record<CampaignWarning['code'], (warning: CampaignWarning) => string> = {
  TRACKER_BUDGETS_EXCEED_CAMPAIGN: (warning) =>
    `Tracker budgets (${String(warning.detail.trackerTotal)}) add up to more than the campaign budget (${String(warning.detail.campaignBudget)}) for ${warning.unitCode ?? 'this unit'}. That is allowed — not every tracker is fully used — but the campaign budget always wins.`,
  CUSTOMER_LIMIT_EXCEEDS_DAILY_BUDGET: (warning) =>
    `A single customer may earn ${String(warning.detail.customerDailyLimit)} per day, but the whole campaign's daily budget is ${String(warning.detail.campaignDailyBudget)}. The budget will stop the first customer.`,
  CUSTOMER_CAMPAIGN_LIMIT_UNREACHABLE: (warning) =>
    `The per-customer campaign limit of ${String(warning.detail.campaignLimit)} cannot be reached: ${String(warning.detail.dailyLimit)} per day over ${String(warning.detail.campaignDays)} days is at most ${String(warning.detail.maximumReachable)}.`,
  REWARD_UNIT_HAS_NO_BUDGET: (warning) =>
    `Your ${warning.unitCode ?? ''} reward has no budget. It will be uncapped.`,
  BUDGET_NEAR_TENANT_CEILING: (warning) =>
    `This is ${String(warning.detail.percentOfCeiling)}% of your tenant's ceiling for ${warning.unitCode ?? 'this unit'}.`,
  BUDGET_ABOVE_TENANT_CEILING: (warning) =>
    `The ${warning.unitCode ?? ''} budget is above your tenant's ceiling of ${String(warning.detail.maxCampaignBudget)}. The campaign cannot be submitted until it comes down.`,
  CAP_CURRENCY_DIFFERS_FROM_CAMPAIGN: (warning) =>
    `A cap is denominated in ${warning.unitCode ?? ''}, but this campaign's currency is ${String(warning.detail.campaignCurrency)}.`,
};

function WarningsPanel({ warnings }: { readonly warnings: readonly CampaignWarning[] }) {
  if (warnings.length === 0) return null;

  return (
    <ul className="grid gap-2">
      {warnings.map((warning, index) => (
        <li
          key={`${warning.code}-${warning.unitCode ?? ''}-${String(index)}`}
          role="status"
          className={
            warning.code === 'BUDGET_ABOVE_TENANT_CEILING'
              ? 'rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700'
              : 'rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800'
          }
        >
          {WARNING_TEXT[warning.code](warning)}
        </li>
      ))}
    </ul>
  );
}

interface CapPanelProps {
  readonly title: string;
  readonly description: string;
  readonly drafts: readonly Draft[];
  readonly journey: Journey | undefined;
  readonly disabled?: boolean;
  readonly onAdd: () => void;
  readonly onUpdate: (localId: string, patch: Partial<CampaignCapInput>) => void;
  readonly onRemove: (localId: string) => void;
}

function CapPanel({
  title,
  description,
  drafts,
  journey,
  disabled,
  onAdd,
  onUpdate,
  onRemove,
}: CapPanelProps) {
  const trackerOptions = (journey?.trackers ?? []).map((tracker) => ({
    value: String(tracker.id),
    label: tracker.name,
  }));

  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        <p className="text-sm text-slate-500">{description}</p>
      </CardHeader>
      <CardBody className="grid gap-4">
        {drafts.length === 0 && <p className="text-sm text-slate-500">None set.</p>}

        {drafts.map((draft) => (
          <div
            key={draft.localId}
            className="grid gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-3"
          >
            <Select
              label="Applies to"
              value={draft.scopeLevel}
              disabled={disabled}
              options={[
                { value: 'campaign', label: 'The whole campaign' },
                { value: 'tracker', label: 'One tracker' },
              ]}
              onChange={(value) => {
                onUpdate(draft.localId, {
                  scopeLevel: value as CampaignCapInput['scopeLevel'],
                  scopeRefId: value === 'campaign' ? null : (journey?.trackers[0]?.id ?? null),
                });
              }}
            />

            {draft.scopeLevel === 'tracker' && (
              <Select
                label="Tracker"
                value={
                  draft.scopeRefId === null || draft.scopeRefId === undefined
                    ? null
                    : String(draft.scopeRefId)
                }
                disabled={disabled}
                options={trackerOptions}
                onChange={(value) => {
                  onUpdate(draft.localId, { scopeRefId: Number(value) });
                }}
              />
            )}

            <Select
              label="Period"
              value={draft.periodType}
              disabled={disabled}
              options={[
                { value: 'lifetime', label: 'Whole campaign' },
                { value: 'daily', label: 'Per day' },
                { value: 'monthly', label: 'Per calendar month' },
                { value: 'time_of_day', label: 'Time of day' },
                { value: 'rolling_hours', label: 'Rolling hours' },
              ]}
              onChange={(value) => {
                onUpdate(draft.localId, { periodType: value as CampaignCapInput['periodType'] });
              }}
            />

            {draft.periodType === 'time_of_day' && (
              <>
                <Input
                  type="time"
                  label="From"
                  value={draft.windowStartTime ?? ''}
                  disabled={disabled}
                  onChange={(event) => {
                    onUpdate(draft.localId, { windowStartTime: event.target.value });
                  }}
                />
                <Input
                  type="time"
                  label="To"
                  value={draft.windowEndTime ?? ''}
                  disabled={disabled}
                  onChange={(event) => {
                    onUpdate(draft.localId, { windowEndTime: event.target.value });
                  }}
                />
              </>
            )}

            {draft.periodType === 'rolling_hours' && (
              <Input
                type="number"
                min={1}
                label="Every N hours"
                value={
                  draft.periodValue === null || draft.periodValue === undefined
                    ? ''
                    : String(draft.periodValue)
                }
                disabled={disabled}
                onChange={(event) => {
                  onUpdate(draft.localId, { periodValue: Number(event.target.value) });
                }}
              />
            )}

            <Input
              label="Amount"
              hint="Leave blank for a count-only cap."
              value={draft.maxTotalAmount ?? ''}
              disabled={disabled}
              onChange={(event) => {
                onUpdate(draft.localId, {
                  maxTotalAmount: event.target.value === '' ? null : event.target.value,
                });
              }}
            />

            <Input
              label="Unit"
              hint="MYR, PTS, …"
              value={draft.unitCode ?? ''}
              disabled={disabled}
              onChange={(event) => {
                onUpdate(draft.localId, { unitCode: event.target.value.toUpperCase() });
              }}
            />

            <Select
              label="Unit type"
              value={draft.unitType ?? 'currency'}
              disabled={disabled}
              options={[
                { value: 'currency', label: 'Currency' },
                { value: 'points', label: 'Points' },
                { value: 'voucher', label: 'Voucher' },
              ]}
              onChange={(value) => {
                onUpdate(draft.localId, { unitType: value as CampaignCapInput['unitType'] });
              }}
            />

            <Input
              type="number"
              min={1}
              label="Max times"
              hint="Optional; a count rather than an amount."
              value={
                draft.maxOccurrences === null || draft.maxOccurrences === undefined
                  ? ''
                  : String(draft.maxOccurrences)
              }
              disabled={disabled}
              onChange={(event) => {
                onUpdate(draft.localId, {
                  maxOccurrences: event.target.value === '' ? null : Number(event.target.value),
                });
              }}
            />

            {draft.capClass === 'budget' && (
              <>
                <Select
                  label="When it runs out"
                  value={draft.onBreach ?? 'reject'}
                  disabled={disabled}
                  options={[
                    { value: 'reject', label: 'Stop granting' },
                    { value: 'pause_campaign', label: 'Pause the campaign' },
                    { value: 'alert_only', label: 'Alert only' },
                  ]}
                  onChange={(value) => {
                    onUpdate(draft.localId, { onBreach: value as CampaignCapInput['onBreach'] });
                  }}
                />
                <Input
                  type="number"
                  min={1}
                  max={99}
                  label="Warn me at %"
                  value={
                    draft.warnAtPercent === null || draft.warnAtPercent === undefined
                      ? ''
                      : String(draft.warnAtPercent)
                  }
                  disabled={disabled}
                  onChange={(event) => {
                    onUpdate(draft.localId, {
                      warnAtPercent: event.target.value === '' ? null : Number(event.target.value),
                    });
                  }}
                />
              </>
            )}

            <div className="sm:col-span-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  onRemove(draft.localId);
                }}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                Remove
              </Button>
            </div>
          </div>
        ))}

        <div>
          <Button type="button" variant="secondary" disabled={disabled} onClick={onAdd}>
            <Plus className="size-4" aria-hidden="true" />
            Add
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
