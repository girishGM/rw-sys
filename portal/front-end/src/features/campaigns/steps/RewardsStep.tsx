/**
 * T-037 step 5 — *"three reward levels in one view"* (04-FRONTEND.md §5.5).
 *
 * > *"Three separate screens would hide the relationship, so step 5 mirrors the journey tree and
 * > shows **every** attachment point, including empty ones. A maker who cannot see that a
 * > component has no reward will not notice they meant to add one."*
 *
 * So this screen renders the same tree step 3 does, with an attachment slot at each of the three
 * levels whether or not it is filled — the empty ones are the information.
 *
 * The **worst-case payout** line (implementation note 10) sits at the top: all three levels can
 * pay at once, and *"three stacking levels are easy to misjudge"*. It is per unit, never summed
 * across units, because no conversion rate exists anywhere in this design
 * (11-BUDGETS-AND-LIMITS.md §3.1) — and it says "at least" when a policy exposes no amount,
 * rather than printing a confident number that is wrong.
 */
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type {
  Journey,
  RewardAssignment,
  RewardLevel,
  RewardOption,
  WorstCasePayoutLine,
} from '@reward-portal/shared';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Card, CardBody, CardHeader } from '../../../components/Card';
import { EmptyState } from '../../../components/EmptyState';
import { Select } from '../../../components/Select';

export interface RewardsStepProps {
  readonly journey: Journey | undefined;
  readonly rewardOptions: readonly RewardOption[];
  readonly worstCasePayout: readonly WorstCasePayoutLine[];
  readonly disabled?: boolean;
  readonly onAttach: (level: RewardLevel, refId: number | null, rewardPolicyId: number) => void;
  readonly onDetach: (level: RewardLevel, assignmentId: number) => void;
}

export function RewardsStep({
  journey,
  rewardOptions,
  worstCasePayout,
  disabled,
  onAttach,
  onDetach,
}: RewardsStepProps) {
  if (journey === undefined) {
    return <EmptyState message="No journey yet" description="Build the journey first." />;
  }

  return (
    <div className="grid gap-5">
      <WorstCase lines={worstCasePayout} />

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-slate-800">Campaign reward</h3>
        </CardHeader>
        <CardBody>
          <Slot
            level="campaign"
            refId={null}
            assignments={journey.campaignRewards}
            options={rewardOptions}
            disabled={disabled}
            onAttach={onAttach}
            onDetach={onDetach}
            hint="Paid once when the whole campaign is completed."
          />
        </CardBody>
      </Card>

      {journey.trackers.map((tracker) => (
        <Card key={tracker.id}>
          <CardHeader>
            <h3 className="text-sm font-semibold text-slate-800">{tracker.name}</h3>
          </CardHeader>
          <CardBody className="grid gap-5">
            <Slot
              level="tracker"
              refId={tracker.id}
              assignments={tracker.rewards}
              options={rewardOptions}
              disabled={disabled}
              onAttach={onAttach}
              onDetach={onDetach}
              hint="Paid when this tracker completes."
            />

            {tracker.components.map((component) => (
              <div key={component.id} className="rounded-lg border border-slate-200 p-4">
                <h4 className="mb-3 text-sm font-medium text-slate-800">
                  {component.sequenceOrder}. {component.name}
                </h4>
                <Slot
                  level="component"
                  refId={component.id}
                  assignments={component.rewards}
                  options={rewardOptions}
                  disabled={disabled}
                  onAttach={onAttach}
                  onDetach={onDetach}
                  hint="Paid when this step completes."
                />
              </div>
            ))}
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

function WorstCase({ lines }: { readonly lines: readonly WorstCasePayoutLine[] }) {
  if (lines.length === 0) {
    return (
      <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
        No reward is attached anywhere yet. A campaign with no reward cannot be submitted.
      </p>
    );
  }

  return (
    <Card>
      <CardBody className="grid gap-1">
        <h3 className="text-sm font-semibold text-slate-800">
          Worst case, one customer completing everything
        </h3>
        <ul className="grid gap-1 text-sm text-slate-700">
          {lines.map((line) => (
            <li key={`${line.unitType ?? 'none'}:${line.unitCode ?? 'none'}`}>
              {line.hasUnknownAmounts ? 'At least ' : ''}
              <strong>
                {line.perCustomerAmount} {line.unitCode ?? '(unit not declared)'}
              </strong>{' '}
              across {line.attachmentCount} attachment(s)
              {line.hasUnknownAmounts && (
                <span className="text-slate-500">
                  {' '}
                  — some rewards do not publish an amount, so this is a floor
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="text-sm text-slate-500">
          Units are never added together: a points reward and a cash reward are separate budgets.
        </p>
      </CardBody>
    </Card>
  );
}

interface SlotProps {
  readonly level: RewardLevel;
  readonly refId: number | null;
  readonly assignments: readonly RewardAssignment[];
  readonly options: readonly RewardOption[];
  readonly disabled?: boolean;
  readonly hint: string;
  readonly onAttach: (level: RewardLevel, refId: number | null, rewardPolicyId: number) => void;
  readonly onDetach: (level: RewardLevel, assignmentId: number) => void;
}

function Slot({
  level,
  refId,
  assignments,
  options,
  disabled,
  hint,
  onAttach,
  onDetach,
}: SlotProps) {
  const [policyId, setPolicyId] = useState<string | null>(null);
  const available = options.filter(
    (option) => !assignments.some((entry) => entry.rewardPolicyId === option.rewardPolicyId),
  );

  return (
    <div className="grid gap-3">
      {assignments.length === 0 ? (
        <p className="text-sm text-slate-500">No reward here. {hint}</p>
      ) : (
        <ul className="grid gap-2">
          {assignments.map((assignment) => (
            <li
              key={assignment.id}
              className="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm"
            >
              <span className="text-slate-800">
                {assignment.rewardPolicyName}
                {assignment.unitCode !== null && (
                  <Badge tone="slate" className="ml-2">
                    {assignment.amount ?? '?'} {assignment.unitCode}
                  </Badge>
                )}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  onDetach(level, assignment.id);
                }}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <Select
          label="Add a reward"
          className="flex-1"
          placeholder={available.length === 0 ? 'No further rewards available' : 'Select a reward…'}
          value={policyId}
          disabled={disabled || available.length === 0}
          options={available.map((option) => ({
            value: String(option.rewardPolicyId),
            label: `${option.policyName} (${option.rewardName})`,
          }))}
          onChange={setPolicyId}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || policyId === null}
          onClick={() => {
            if (policyId === null) return;
            onAttach(level, refId, Number(policyId));
            setPolicyId(null);
          }}
        >
          <Plus className="size-4" aria-hidden="true" />
          Attach
        </Button>
      </div>
    </div>
  );
}
