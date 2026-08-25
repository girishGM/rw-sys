/**
 * T-038 — the side-by-side diff (04-FRONTEND.md §4, *"Full payload diff"*; implementation note 7).
 *
 * ### This component has no error state, because the diff has no error mode
 *
 * `approvalDiffSchema` is total: every way a payload can be unusable is a *value* (`problem`),
 * never an exception (see the schema's own header, and `approval-diff.ts` server-side). So there
 * is no `try`, no boundary and no "something went wrong" here — there is a `problem` to render and
 * whatever context could still be extracted alongside it. That is TC-20's *"readable 'cannot
 * render diff' state, never a crash on a checker's queue"* discharged by construction rather than
 * by defensive coding.
 *
 * ### Everything rendered here is text, and that is deliberate
 *
 * Every value below comes out of a `jsonb` column that a maker's input reached. It is rendered as
 * React children — escaped text — and never as HTML. There is no `dangerouslySetInnerHTML` in this
 * feature at all, which is the only reliable way to keep it that way.
 */
import type { ApprovalDiff } from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Card, CardBody, CardHeader } from '../../components/Card';

const PROBLEM_COPY: Record<string, string> = {
  PAYLOAD_MISSING:
    'Nothing was recorded when this campaign was submitted, so there is no before-and-after to show.',
  PAYLOAD_NOT_AN_OBJECT:
    'The submission record is not in a shape this screen can compare. Review the campaign itself before deciding.',
  SUBJECT_UNAVAILABLE:
    'The campaign this request refers to is no longer available to you, so it cannot be compared.',
};

export interface ApprovalDiffPanelProps {
  readonly diff: ApprovalDiff;
}

export function ApprovalDiffPanel({ diff }: ApprovalDiffPanelProps) {
  return (
    <div className="grid gap-4">
      {!diff.renderable && (
        <Card>
          <CardBody>
            <p className="text-sm font-medium text-slate-800">Cannot show a comparison</p>
            <p className="mt-1 text-sm text-slate-600">
              {diff.problem === null ? PROBLEM_COPY['PAYLOAD_MISSING'] : PROBLEM_COPY[diff.problem]}
            </p>
          </CardBody>
        </Card>
      )}

      {diff.renderable && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-slate-800">Changes since submission</h3>
          </CardHeader>
          <CardBody>
            {diff.changed.length === 0 ? (
              <p className="text-sm text-slate-600">
                Nothing has changed since this was submitted
                {diff.unchangedCount > 0
                  ? ` — ${String(diff.unchangedCount)} field${diff.unchangedCount === 1 ? '' : 's'} compared.`
                  : '.'}
              </p>
            ) : (
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">Fields changed since submission</caption>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-600">
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Field
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      As submitted
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      Now
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {diff.changed.map((field) => (
                    <tr key={field.field} className="border-b border-slate-100 align-top">
                      <th scope="row" className="py-2 pr-4 text-left font-medium text-slate-700">
                        {field.label}
                      </th>
                      <td className="py-2 pr-4 text-slate-500 line-through">
                        {field.before ?? '—'}
                      </td>
                      <td className="py-2 font-medium text-slate-800">{field.after ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {diff.skippedFields.length > 0 && (
              // A half-rendered diff that says so beats a half-rendered diff that looks complete.
              <p className="mt-3 text-xs text-slate-500">
                Not compared: {diff.skippedFields.join(', ')}
              </p>
            )}
          </CardBody>
        </Card>
      )}

      {diff.budgets.length > 0 && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-slate-800">Budget at submission</h3>
          </CardHeader>
          <CardBody>
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Budget lines recorded at submission</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-600">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Unit
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Campaign budget
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Tenant ceiling
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Share of ceiling
                  </th>
                </tr>
              </thead>
              <tbody>
                {diff.budgets.map((line) => (
                  <tr
                    key={`${line.unitType}:${line.unitCode}`}
                    className="border-b border-slate-100"
                  >
                    <th scope="row" className="py-2 pr-4 text-left font-medium text-slate-700">
                      {line.unitCode}
                      <span className="ml-2 font-normal text-slate-500">{line.unitType}</span>
                    </th>
                    <td className="py-2 pr-4 text-slate-800">{line.campaignBudget}</td>
                    <td className="py-2 pr-4 text-slate-600">{line.maxCampaignBudget ?? '—'}</td>
                    <td className="py-2">
                      {/* T-037 note 18 put this in the payload so a checker sees an unusual
                          number without doing arithmetic. Rendering it is the whole point. */}
                      <Badge
                        tone={
                          line.state === 'over'
                            ? 'danger'
                            : line.state === 'warn'
                              ? 'warning'
                              : 'success'
                        }
                      >
                        {line.percentOfCeiling === null
                          ? line.state
                          : `${String(line.percentOfCeiling)}%`}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {diff.warnings.length > 0 && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-slate-800">Warnings raised at submission</h3>
          </CardHeader>
          <CardBody>
            <ul className="grid gap-1 text-sm text-slate-700">
              {diff.warnings.map((warning) => (
                <li key={warning}>
                  <Badge tone="warning">{warning}</Badge>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {(diff.trackerCount !== null || diff.componentCount !== null) && (
        <p className="text-sm text-slate-600">
          Journey as submitted: {diff.trackerCount ?? '—'} tracker(s), {diff.componentCount ?? '—'}{' '}
          component(s).
        </p>
      )}
    </div>
  );
}
