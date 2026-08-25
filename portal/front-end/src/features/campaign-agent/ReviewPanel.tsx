/**
 * T-049 — the review panel (architecture.html §14's `.revpanel`, 10-AI §4 step 9).
 *
 * ### Nothing is created until the button below is clicked
 *
 * Implementation note 3: *"Review panel before anything is created. Full structured summary; the
 * confirm button submits the plan hash."* The panel is a rendering of {@link AgentPlan} — the same
 * object the server hashed — and the confirm sends **only** that hash back
 * (`useAgentSession.confirmPlan`). The server rebuilds the plan from the maker's own answers,
 * recomputes the hash and refuses on a mismatch (10-AI §3.2), so what this panel shows and what
 * gets built are the same thing by construction rather than by care.
 *
 * ### The approval step is stated, not implied (implementation note 4, TC-8)
 *
 * *"The chat never submits for approval; make that visible in the copy so the maker knows there is
 * still a step."* It is said twice on purpose — once before the click, in the sentence above the
 * button, and once after it, in the server's own hand-off message. A maker who believes the
 * assistant submitted for them is a maker whose campaign silently never runs.
 *
 * ### Focus (implementation note 7, TC-17)
 *
 * The panel takes focus when it appears. It is added *above* the composer the maker was last in,
 * so a screen-reader or keyboard user would otherwise be left at the bottom of a stream that
 * changed above them, with no announcement that the most consequential control on the page now
 * exists.
 */
import { useEffect, useRef } from 'react';
import type { AgentPlan } from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { formatCalendarDateRange } from '../campaigns/campaignDate';
import type { AgentFailure } from './useAgentSession';

export interface ReviewPanelProps {
  readonly plan: AgentPlan;
  readonly busy: boolean;
  readonly failure: AgentFailure | null;
  readonly onConfirm: () => void;
  readonly onKeepEditing: () => void;
}

const ARCHETYPE_LABEL: Readonly<Record<AgentPlan['archetype'], string>> = {
  instant_reward: 'Instant reward',
  deferred_reward: 'Deferred reward',
};

export function ReviewPanel({ plan, busy, failure, onConfirm, onKeepEditing }: ReviewPanelProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const { campaign, tracker } = plan;

  return (
    <section
      aria-labelledby="agent-review-heading"
      className="grid gap-3 rounded-card border border-primary-200 bg-primary-50/40 p-4"
    >
      <h3
        id="agent-review-heading"
        ref={headingRef}
        tabIndex={-1}
        className="text-sm font-semibold text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
      >
        Review before creating
      </h3>

      <dl className="grid gap-1.5 text-sm text-slate-700">
        <Row label="Name" value={campaign.name} />
        <Row label="Code" value={campaign.campaignCode} />
        <Row label="Pattern" value={ARCHETYPE_LABEL[plan.archetype]} />
        {/* T-065 — the wizard's own formatter. A plan the maker confirms here becomes a campaign
            they then open in the wizard, and the two screens showing different days for one
            campaign is precisely the defect this shares a fix with. */}
        <Row label="Runs" value={formatCalendarDateRange(campaign.startDate, campaign.endDate)} />
        <Row
          label="Budget"
          value={
            campaign.budgetAmount === null
              ? 'No budget set'
              : `${campaign.budgetAmount} ${campaign.budgetCurrency ?? ''}`.trim()
          }
        />
        <Row label="Merchants" value={plan.merchants.map((entry) => entry.name).join(', ')} />
        <Row
          label="Tracker"
          value={`${tracker.name} · ${
            tracker.completionLogic === 'n_of'
              ? `any ${String(tracker.completionThreshold ?? 0)} of ${String(plan.components.length)}`
              : tracker.completionLogic
          }`}
        />
      </dl>

      <div className="grid gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Steps and rules
        </h4>
        <ul className="grid gap-2 text-sm text-slate-700">
          {plan.components.map((component, index) => (
            <li key={`${component.activityId}-${String(index)}`} className="grid gap-1">
              <span className="font-medium text-slate-800">{component.activityName}</span>
              <ul className="ml-4 grid list-disc gap-0.5">
                {component.rules.map((rule, ruleIndex) => (
                  <li key={`${rule.ruleId}-${String(ruleIndex)}`}>
                    {rule.ruleName === '' ? rule.ruleCode : rule.ruleName}
                    {rule.ruleVersionNo !== null && (
                      <span className="ml-1 text-xs text-slate-500">v{rule.ruleVersionNo}</span>
                    )}
                    {formatValues(rule.values) !== '' && (
                      <span className="text-slate-500"> — {formatValues(rule.values)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rewards</h4>
        <ul className="grid gap-0.5 text-sm text-slate-700">
          {plan.rewards.map((reward, index) => (
            <li key={`${reward.rewardPolicyId}-${String(index)}`}>
              {reward.policyName} — paid at {reward.level} level
              {reward.componentIndex !== null &&
                plan.components[reward.componentIndex] !== undefined &&
                ` (${plan.components[reward.componentIndex].activityName})`}
            </li>
          ))}
        </ul>
      </div>

      {plan.caps.length > 0 && (
        <div className="grid gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Limits and caps
          </h4>
          <ul className="grid gap-0.5 text-sm text-slate-700">
            {plan.caps.map((cap, index) => (
              <li key={`${cap.capClass}-${String(index)}`}>
                {cap.capClass} · {cap.scopeLevel} · {cap.periodType} ·{' '}
                {cap.maxTotalAmount === null || cap.maxTotalAmount === undefined
                  ? `${String(cap.maxOccurrences ?? 0)} times`
                  : `${cap.maxTotalAmount} ${cap.unitCode ?? ''}`.trim()}
              </li>
            ))}
          </ul>
        </div>
      )}

      {failure !== null && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {failure.message}
          {failure.codes.length > 0 && (
            <span className="mt-1 block text-xs">
              {failure.codes.map((code) => code.replaceAll('_', ' ').toLowerCase()).join(' · ')}
            </span>
          )}
        </p>
      )}

      <p className="text-sm text-slate-600">
        Creating this saves a <strong>draft</strong>. Submitting it for approval is still yours to
        do — the assistant never submits a campaign for approval.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button type="button" isLoading={busy} onClick={onConfirm}>
          Create draft
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onKeepEditing}>
          Change something
        </Button>
      </div>
    </section>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="w-28 shrink-0 text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-800">{value}</dd>
    </div>
  );
}

/**
 * A rule's dynamic values, as `key value` pairs.
 *
 * `JSON.stringify` for anything that is not a string or a number: the values come from a rule
 * version's own parameter schema (T-031), which allows arrays and objects, and `String({})` would
 * render `[object Object]` — a summary that hides what is about to be created is worse than a
 * slightly technical one.
 */
function formatValues(values: Record<string, unknown>): string {
  return Object.entries(values)
    .map(([key, value]) => {
      const rendered =
        typeof value === 'string' || typeof value === 'number'
          ? String(value)
          : JSON.stringify(value);
      return `${key} ${rendered}`;
    })
    .join(', ');
}
