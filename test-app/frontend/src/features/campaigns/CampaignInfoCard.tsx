/**
 * T-008 — the campaign info card (`ARCHITECTURE.md` §4: "campaign info (description, region,
 * dates)"). `region` and a separate "eligibility" field this task's own file names are not real
 * fields anywhere: `tracking-service`'s `PortalCampaign` DTO (`portal-client/types.ts`, T-003)
 * deliberately has no `region` column — "the real `Campaign` DTO has no such field" — and no
 * `reward_config`/portal schema models campaign "eligibility" as its own attribute at all (the
 * closest real concept, merchant/tenant scoping, is an internal portal-access rule, not customer-
 * facing copy). Per `AGENT-PROTOCOL.md` §3 ("if a design doc contradicts itself, stop and
 * escalate" / "the design doc wins" only when the doc is internally consistent): `ARCHITECTURE.md`
 * §4 itself only lists "description, region, dates" (no eligibility) and T-003's own already-
 * recorded deviation settled the `region` question before this task started, so this card shows
 * the two real fields that exist — description and dates — rather than fabricating placeholder
 * copy for either. Flagged again here, not silently dropped — see this task's completion report.
 */
import { Card } from '../../components/Card';
import { formatDateRange } from './formatDateRange';

export interface CampaignInfoCardProps {
  description: string | null;
  startDate: string;
  endDate: string;
}

export function CampaignInfoCard({ description, startDate, endDate }: CampaignInfoCardProps) {
  return (
    <Card className="flex flex-col gap-4 p-5 sm:p-6">
      <h2 className="font-heading text-base font-semibold text-ink sm:text-[17px]">
        About this campaign
      </h2>
      {description && <p className="font-body text-sm text-ink-muted">{description}</p>}
      <dl>
        <dt className="font-body text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Campaign dates
        </dt>
        <dd className="font-body text-sm font-medium text-ink">
          {formatDateRange(startDate, endDate)}
        </dd>
      </dl>
    </Card>
  );
}
