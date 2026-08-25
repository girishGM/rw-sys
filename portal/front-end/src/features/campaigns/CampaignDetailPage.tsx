/**
 * T-037 — `/campaigns/:id`: the campaign detail screen (04-FRONTEND.md §4, *"Header, tabs:
 * Overview / Journey / Rules / Rewards / Merchants / Audit"*).
 *
 * A **draft** opens straight into the wizard instead — an editable campaign has no meaningful
 * read-only view, and sending a maker to a summary they then have to click "edit" on is a step
 * that exists only because the router has two routes. Anything past `draft` is read-only, so it
 * gets the tabbed detail.
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import type {
  Campaign,
  CampaignAuditEntry,
  CampaignCapRow,
  CampaignMerchantLink,
  Journey,
} from '@reward-portal/shared';
import { Badge } from '../../components/Badge';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';
import { CampaignStatusPill } from './CampaignStatusPill';
import { CampaignWizardPage } from './CampaignWizardPage';
import { formatCalendarDateRange } from './campaignDate';
import {
  useAuditQuery,
  useCampaignMerchantsQuery,
  useCampaignQuery,
  useCapsQuery,
  useJourneyQuery,
} from './api';

export function CampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const campaignId = params.id === undefined ? null : Number(params.id);
  const [tab, setTab] = useState('overview');

  const campaignQuery = useCampaignQuery(campaignId);
  const journeyQuery = useJourneyQuery(campaignId);
  const merchantsQuery = useCampaignMerchantsQuery(campaignId);
  const capsQuery = useCapsQuery(campaignId);
  const auditQuery = useAuditQuery(campaignId);

  const campaign = campaignQuery.data;

  if (campaignQuery.isLoading || campaign === undefined) {
    return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  }

  // An editable campaign is the wizard. See this file's header.
  if (campaign.editable) return <CampaignWizardPage />;

  const journey = journeyQuery.data;

  return (
    <div className="p-6">
      <PageHeader
        title={campaign.name}
        description={`${campaign.campaignCode} · ${formatCalendarDateRange(campaign.startDate, campaign.endDate)}`}
        actions={<CampaignStatusPill status={campaign.effectiveStatus} />}
      />

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'overview', label: 'Overview', panel: <OverviewPanel campaign={campaign} /> },
          {
            value: 'journey',
            label: 'Journey',
            panel: <JourneyPanel journey={journey} />,
          },
          {
            value: 'merchants',
            label: 'Merchants',
            panel: <MerchantsPanel merchants={merchantsQuery.data ?? []} />,
          },
          {
            value: 'budgets',
            label: 'Budgets',
            panel: <BudgetsPanel caps={capsQuery.data?.caps ?? []} />,
          },
          {
            value: 'audit',
            label: 'Audit',
            panel: <AuditList entries={auditQuery.data ?? []} />,
          },
        ]}
      />
    </div>
  );
}

function OverviewPanel({ campaign }: { readonly campaign: Campaign }) {
  return (
    <div className="mt-5">
      <Card>
        <CardBody className="grid gap-2 text-sm text-slate-700">
          <div>
            Created by <strong>{campaign.createdBy}</strong>
          </div>
          {campaign.approvedBy !== null && (
            <div>
              Approved by <strong>{campaign.approvedBy}</strong> on{' '}
              {campaign.approvedAt === null ? '—' : new Date(campaign.approvedAt).toLocaleString()}
            </div>
          )}
          {campaign.lastReviewComment !== null && (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-amber-800">
              Checker comment: {campaign.lastReviewComment}
            </div>
          )}
          <div>
            Budget:{' '}
            {campaign.budgetAmount === null
              ? 'uncapped'
              : `${campaign.budgetAmount} ${campaign.budgetCurrency ?? ''}`}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function JourneyPanel({ journey }: { readonly journey: Journey | undefined }) {
  return (
    <div className="mt-5">
      {journey === undefined || journey.trackers.length === 0 ? (
        <EmptyState message="No journey" description="This campaign has no trackers." />
      ) : (
        <div className="grid gap-4">
          {journey.trackers.map((tracker) => (
            <Card key={tracker.id}>
              <CardHeader className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-slate-800">{tracker.name}</h3>
                <Badge tone="slate">
                  {tracker.completionLogic === 'n_of'
                    ? `any ${String(tracker.completionThreshold ?? 0)} of ${String(tracker.components.length)}`
                    : tracker.completionLogic}
                </Badge>
              </CardHeader>
              <CardBody>
                <ul className="grid gap-2 text-sm">
                  {tracker.components.map((component) => (
                    <li key={component.id} className="rounded-md bg-slate-50 px-3 py-2">
                      <div className="font-medium text-slate-800">
                        {component.sequenceOrder}. {component.name}
                        {!component.isMandatory && (
                          <Badge tone="slate" className="ml-2">
                            optional
                          </Badge>
                        )}
                      </div>
                      <div className="text-slate-600">
                        Activity: {component.activityName ?? '—'} · {component.rules.length} rule(s)
                        · {component.rewards.length} reward(s)
                      </div>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function MerchantsPanel({ merchants }: { readonly merchants: readonly CampaignMerchantLink[] }) {
  return (
    <div className="mt-5">
      <Card>
        <CardBody>
          <ul className="grid gap-1 text-sm text-slate-700">
            {merchants.map((merchant) => (
              <li key={merchant.id}>
                {merchant.name} ({merchant.merchantCode})
              </li>
            ))}
            {merchants.length === 0 && <li>No merchants.</li>}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}

function BudgetsPanel({ caps }: { readonly caps: readonly CampaignCapRow[] }) {
  return (
    <div className="mt-5">
      <Card>
        <CardBody className="grid gap-2 text-sm text-slate-700">
          {caps.length === 0 && <p>No budgets or limits set.</p>}
          {caps.map((cap) => (
            <div key={cap.id}>
              <Badge tone={cap.capClass === 'budget' ? 'primary' : 'slate'}>{cap.capClass}</Badge>{' '}
              {cap.scopeLevel} · {cap.periodType} ·{' '}
              {cap.maxTotalAmount === null
                ? `${String(cap.maxOccurrences ?? 0)} times`
                : `${cap.maxTotalAmount} ${cap.unitCode ?? ''}`}
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

function AuditList({ entries }: { readonly entries: readonly CampaignAuditEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="mt-5">
        <EmptyState message="No audit entries" description="Nothing has happened yet." />
      </div>
    );
  }

  return (
    <Card className="mt-5">
      <CardBody>
        <ul className="grid gap-2 text-sm">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap gap-2 border-b border-slate-100 pb-2">
              <span className="text-slate-500">{new Date(entry.performedAt).toLocaleString()}</span>
              <Badge tone="slate">{entry.action}</Badge>
              <span className="text-slate-700">{entry.entityType}</span>
              <span className="text-slate-500">
                by {entry.performedByName ?? `user ${String(entry.performedBy)}`}
              </span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
