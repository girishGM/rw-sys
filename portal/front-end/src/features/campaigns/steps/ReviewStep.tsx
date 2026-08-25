/**
 * T-037 step 7 — *"Review: full summary + submit for approval"* (04-FRONTEND.md §5.2).
 *
 * Everything shown here comes from one server call (`GET /campaigns/:id/review`), including
 * `submittable` — so the button's state and the server's decision are the same computation.
 * The screen never decides for itself whether a campaign may be submitted; if it did, the two
 * could disagree and the maker would be told one thing and shown another.
 *
 * The submit button being disabled is **not** the control. `POST /campaigns/:id/submit`
 * re-validates the structure (422 `CAMPAIGN_STRUCTURE_INCOMPLETE`) and the tenant ceiling (422
 * `BUDGET_EXCEEDS_TENANT_CEILING`) regardless of what this screen rendered — TC-21kk is exactly
 * a `curl` that never loaded this page.
 */
import type { CampaignReview, StructuralIssue } from '@reward-portal/shared';
import { formatCalendarDate } from '../campaignDate';
import { Badge } from '../../../components/Badge';
import { Button } from '../../../components/Button';
import { Card, CardBody, CardHeader } from '../../../components/Card';

export interface ReviewStepProps {
  readonly review: CampaignReview | undefined;
  readonly submitting: boolean;
  readonly submitError?: string;
  readonly onSubmit: () => void;
}

const ISSUE_TEXT: Record<StructuralIssue['code'], string> = {
  CAMPAIGN_HAS_NO_MERCHANT: 'Pick at least one participating merchant in step 2.',
  CAMPAIGN_HAS_NO_TRACKER: 'Add at least one tracker in step 3.',
  CAMPAIGN_HAS_NO_REWARD:
    'Attach at least one reward in step 5 — otherwise the campaign can never pay out.',
  TRACKER_HAS_NO_COMPONENT: 'A tracker has no steps, so it can never complete.',
  COMPONENT_HAS_NO_ACTIVITY: 'A step has no activity to track.',
  COMPONENT_HAS_NO_RULE: 'A step has no rule, so it can never complete.',
  THRESHOLD_ABOVE_COMPONENT_COUNT:
    'A tracker asks for more steps than it has, so no customer could ever finish it.',
  RULE_VALUES_INCOMPLETE: 'A rule is missing a required value — set it in step 4.',
};

export function ReviewStep({ review, submitting, submitError, onSubmit }: ReviewStepProps) {
  if (review === undefined) return null;

  const { campaign, merchants, journey, caps, warnings, ceilings, worstCasePayout, issues } =
    review;

  return (
    <div className="grid gap-5">
      {issues.length > 0 && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-rose-700">
              Not ready to submit ({issues.length})
            </h3>
          </CardHeader>
          <CardBody>
            <ul className="grid gap-1 text-sm text-rose-700">
              {issues.map((issue, index) => (
                <li key={`${issue.code}-${String(index)}`}>{ISSUE_TEXT[issue.code]}</li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-slate-800">{campaign.name}</h3>
        </CardHeader>
        <CardBody className="grid gap-2 text-sm text-slate-700">
          <div>
            Code <strong>{campaign.campaignCode}</strong> · {formatCalendarDate(campaign.startDate)}{' '}
            to {formatCalendarDate(campaign.endDate)}
          </div>
          <div>
            Merchants:{' '}
            {merchants.length === 0 ? 'none' : merchants.map((entry) => entry.name).join(', ')}
          </div>
          <div>
            {journey.trackers.length} tracker(s),{' '}
            {journey.trackers.reduce((total, tracker) => total + tracker.components.length, 0)}{' '}
            step(s)
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-slate-800">Journey</h3>
        </CardHeader>
        <CardBody className="grid gap-3 text-sm">
          {journey.trackers.map((tracker) => (
            <div key={tracker.id}>
              <div className="font-medium text-slate-800">
                {tracker.name}{' '}
                <Badge tone="slate">
                  {tracker.completionLogic === 'n_of'
                    ? `any ${String(tracker.completionThreshold ?? 0)} of ${String(tracker.components.length)}`
                    : tracker.completionLogic}
                </Badge>
              </div>
              <ul className="ml-4 list-disc text-slate-600">
                {tracker.components.map((component) => (
                  <li key={component.id}>
                    {component.name} — {component.rules.length} rule(s), {component.rewards.length}{' '}
                    reward(s)
                    {!component.isMandatory && ' · optional'}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-slate-800">Budgets and limits</h3>
        </CardHeader>
        <CardBody className="grid gap-2 text-sm text-slate-700">
          {caps.length === 0 && <p>No budgets or limits set — this campaign is uncapped.</p>}
          {caps.map((cap) => (
            <div key={cap.id}>
              <Badge tone={cap.capClass === 'budget' ? 'primary' : 'slate'}>{cap.capClass}</Badge>{' '}
              {cap.scopeLevel} · {cap.periodType} ·{' '}
              {cap.maxTotalAmount === null
                ? `${String(cap.maxOccurrences ?? 0)} times`
                : `${cap.maxTotalAmount} ${cap.unitCode ?? ''}`}
            </div>
          ))}

          {worstCasePayout.map((line) => (
            <div key={line.unitCode ?? 'none'} className="text-slate-600">
              Worst case per customer: {line.hasUnknownAmounts ? 'at least ' : ''}
              {line.perCustomerAmount} {line.unitCode ?? ''}
            </div>
          ))}

          {ceilings.map((ceiling) => (
            <div key={`${ceiling.unitType}:${ceiling.unitCode}`} className="text-slate-600">
              {ceiling.unitCode}: {ceiling.campaignBudget}
              {ceiling.maxCampaignBudget !== null &&
                ` of a ${ceiling.maxCampaignBudget} tenant ceiling (${String(ceiling.percentOfCeiling)}%)`}
            </div>
          ))}
        </CardBody>
      </Card>

      {warnings.length > 0 && (
        <ul className="grid gap-2">
          {warnings.map((warning, index) => (
            <li
              key={`${warning.code}-${String(index)}`}
              role="status"
              className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800"
            >
              {warning.code.replaceAll('_', ' ').toLowerCase()}
              {warning.unitCode !== null && ` (${warning.unitCode})`}
            </li>
          ))}
        </ul>
      )}

      {submitError !== undefined && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {submitError}
        </p>
      )}

      <div>
        <Button
          type="button"
          isLoading={submitting}
          disabled={!review.submittable}
          onClick={onSubmit}
        >
          Submit for approval
        </Button>
      </div>
    </div>
  );
}
