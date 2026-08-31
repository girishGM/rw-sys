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
 *
 * ### T-127 — the one reward whose value isn't decided here
 *
 * A reward whose live version is `PROMO_CODE` pays no amount at all; what it is worth is decided
 * at redemption (`13-REWARD-MASTER-VALUE-SOURCES.md` §5). Two things follow, both handled in
 * {@link Slot} and neither special-cased per level:
 *
 *  - it is only offered at the levels its own `value_config.bindLevels` names, and
 *  - picking one reveals the live Promo Code Config picker, whose value rides along with the
 *    attach call into the policy's `config` JSON.
 *
 * Every other Kind is untouched: no promo-code UI renders for it, and its attach payload is
 * byte-for-byte what it was before this task.
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
import { Input } from '../../../components/Input';
import { Select } from '../../../components/Select';
import { PromoCodeConfigPicker } from '../PromoCodeConfigPicker';

/** The Maker's chosen cashback amount, for a `FIXED_AMOUNT` reward left unset at creation time —
 * mirrors `promoCodeConfig`'s own "only ever set for the one Kind that needs it" convention. */
export interface CashbackAttachValue {
  readonly amount: string;
  readonly currency: string;
}

export interface RewardsStepProps {
  readonly journey: Journey | undefined;
  readonly rewardOptions: readonly RewardOption[];
  readonly worstCasePayout: readonly WorstCasePayoutLine[];
  readonly disabled?: boolean;
  readonly onAttach: (
    level: RewardLevel,
    refId: number | null,
    rewardPolicyId: number,
    /** T-127 — only ever non-null for a `PROMO_CODE` reward whose picker offered a choice. */
    promoCodeConfig: string | null,
    /** Only ever non-null for a `FIXED_AMOUNT` reward left unset at creation time. */
    cashback: CashbackAttachValue | null,
    /** Only ever non-null for a `POINTS` reward left unset at creation time. */
    points: number | null,
  ) => void;
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
  readonly onAttach: RewardsStepProps['onAttach'];
  readonly onDetach: (level: RewardLevel, assignmentId: number) => void;
}

/**
 * T-127 — may this reward be attached *here*?
 *
 * Only a `PROMO_CODE` reward answers anything but "yes": its `value_config.bindLevels` is the
 * Super Admin's answer to "Where can this be attached?" and the server enforces the same rule on
 * `POST /campaigns/:id/rewards`. `null` bindLevels means the version never stated a restriction
 * (an older row, or a config the server could not parse) — treated as "no restriction", matching
 * `BindingsService.assertPromoCodeAttachable` exactly, so the picker can never offer something
 * the server will refuse, nor hide something it would have accepted.
 */
function isAttachableAt(option: RewardOption, level: RewardLevel): boolean {
  if (option.rewardKind !== 'PROMO_CODE' || option.promoCodeBindLevels === null) return true;
  return option.promoCodeBindLevels.includes(level);
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
  const [promoCodeConfig, setPromoCodeConfig] = useState<string | null>(null);
  const [cashbackAmount, setCashbackAmount] = useState('');
  const [cashbackCurrency, setCashbackCurrency] = useState('');
  const [points, setPoints] = useState('');
  const available = options.filter(
    (option) =>
      !assignments.some((entry) => entry.rewardPolicyId === option.rewardPolicyId) &&
      isAttachableAt(option, level),
  );
  const selected = available.find((option) => String(option.rewardPolicyId) === policyId) ?? null;
  const needsPromoCodeConfig = selected?.rewardKind === 'PROMO_CODE';
  const needsCashbackAmount = selected?.rewardKind === 'FIXED_AMOUNT' && selected.amount === null;
  const needsPoints = selected?.rewardKind === 'POINTS' && selected.amount === null;

  function resetPickers() {
    setPromoCodeConfig(null);
    setCashbackAmount('');
    setCashbackCurrency('');
    setPoints('');
  }

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

      <div className="grid gap-3">
        <div className="flex items-end gap-2">
          <Select
            label="Add a reward"
            className="flex-1"
            placeholder={
              available.length === 0 ? 'No further rewards available' : 'Select a reward…'
            }
            value={policyId}
            disabled={disabled || available.length === 0}
            options={available.map((option) => ({
              value: String(option.rewardPolicyId),
              label: `${option.policyName} (${option.rewardName})`,
            }))}
            onChange={(next) => {
              setPolicyId(next);
              // A pick made for one reward means nothing for the next one.
              resetPickers();
            }}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={
              disabled ||
              policyId === null ||
              (needsCashbackAmount &&
                (cashbackAmount.trim() === '' || cashbackCurrency.trim() === '')) ||
              (needsPoints && points.trim() === '')
            }
            onClick={() => {
              if (policyId === null) return;
              onAttach(
                level,
                refId,
                Number(policyId),
                needsPromoCodeConfig ? promoCodeConfig : null,
                needsCashbackAmount
                  ? { amount: cashbackAmount.trim(), currency: cashbackCurrency.trim() }
                  : null,
                needsPoints ? Number(points) : null,
              );
              setPolicyId(null);
              resetPickers();
            }}
          >
            <Plus className="size-4" aria-hidden="true" />
            Attach
          </Button>
        </div>

        {/* Rendered only for a PROMO_CODE reward, and identically at all three levels — the Kind
            decides, never the level (TC-3/TC-4). Attaching without a pick stays allowed: today
            the provider is `planned`, so there is nothing to pick. */}
        {needsPromoCodeConfig && (
          <PromoCodeConfigPicker
            value={promoCodeConfig}
            onChange={setPromoCodeConfig}
            disabled={disabled}
          />
        )}

        {/* FIXED_AMOUNT left unset at reward-creation time — the Maker supplies the amount and
            currency here, at attach time, mirroring the promo-code picker's own "the Kind
            decides, never the level" convention. Required, unlike the promo code picker: there
            is no legitimate reason to attach a reward whose amount will never be set. */}
        {needsCashbackAmount && (
          <div className="flex gap-2">
            <Input
              label="Cashback amount"
              className="flex-1"
              placeholder="e.g. 10.00"
              value={cashbackAmount}
              disabled={disabled}
              onChange={(event) => {
                setCashbackAmount(event.target.value);
              }}
            />
            <Input
              label="Currency"
              className="w-24"
              placeholder="MYR"
              maxLength={3}
              value={cashbackCurrency}
              disabled={disabled}
              onChange={(event) => {
                setCashbackCurrency(event.target.value.toUpperCase());
              }}
            />
          </div>
        )}

        {/* POINTS left unset at reward-creation time — same convention as cashback above. */}
        {needsPoints && (
          <Input
            label="Points"
            type="number"
            min={0}
            placeholder="e.g. 100"
            value={points}
            disabled={disabled}
            onChange={(event) => {
              setPoints(event.target.value);
            }}
          />
        )}
      </div>
    </div>
  );
}
