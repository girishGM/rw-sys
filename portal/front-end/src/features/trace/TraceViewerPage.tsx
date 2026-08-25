/**
 * T-045 — the support-facing screen 08-OBSERVABILITY.md §6 exists for: turn one `correlationId`
 * into the complete story of a request.
 *
 * `super_admin`-only on the server (`trace.controller.ts`'s own header explains why). Reached
 * through `/trace/:correlationId`, behind `router.tsx`'s ordinary `ProtectedLayout` guard chain
 * (authenticated + bootstrapped) — but *not* `RequirePermission`, since access here is a static
 * role check rather than a `role_entity_permissions` grant; see the role check a few lines below
 * for why, and `router.tsx`'s own route-table comment for the same point made where the route is
 * registered.
 */
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Ban, CheckCircle2, HelpCircle } from 'lucide-react';
import type { TraceResponse, TraceSourceStatus } from '@reward-portal/shared';
import { Badge, type BadgeTone } from '../../components/Badge';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { Skeleton } from '../../components/Skeleton';
import { Tabs } from '../../components/Tabs';
import { useBootstrap } from '../../auth/useBootstrap';
import { Forbidden } from '../../pages/Forbidden';
import { ApiError } from '../../lib/apiError';
import { fetchTrace, traceQueryKey } from './api';
import { ApprovalRequestLink, CampaignLink } from './components/TraceLink';
import { SpanWaterfall } from './components/SpanWaterfall';

const SOURCE_LABEL: Record<keyof TraceResponse['sources'], string> = {
  portalAuditLog: 'Portal audit log',
  domainAudit: 'Campaign audit trail',
  logStore: 'Log store',
  configFetches: 'Config fetches (gRPC)',
};

const SOURCE_TONE: Record<TraceSourceStatus, BadgeTone> = {
  available: 'success',
  unavailable: 'danger',
  not_configured: 'slate',
};

const SOURCE_ICON: Record<TraceSourceStatus, typeof CheckCircle2> = {
  available: CheckCircle2,
  unavailable: AlertTriangle,
  not_configured: HelpCircle,
};

function useTrace(correlationId: string, enabled: boolean) {
  return useQuery({
    queryKey: traceQueryKey(correlationId),
    queryFn: () => fetchTrace(correlationId),
    enabled,
    retry: (failureCount, error) => {
      // A 400/403/404 is definitive — the id is malformed, the caller lacks access, or the id
      // matches nothing. None of those improve with a retry.
      if (error instanceof ApiError && [400, 403, 404].includes(error.status)) return false;
      return failureCount < 2;
    },
  });
}

function errorMessage(error: unknown): { title: string; description: string } {
  if (error instanceof ApiError) {
    if (error.status === 400) {
      return {
        title: 'Not a valid correlation id',
        description:
          'Correlation ids are 8–64 letters, digits, "_" or "-". Check the id and try again.',
      };
    }
    if (error.status === 404) {
      return {
        title: 'No trace found for this id',
        description:
          'Nothing was recorded under this correlation id in the audit log or the campaign audit trail.',
      };
    }
    if (error.status === 403) {
      return {
        title: 'Not authorised',
        description:
          'Trace assembly is restricted to Super Admin — it aggregates data across every tenant.',
      };
    }
    return { title: 'Could not load this trace', description: error.message };
  }
  return { title: 'Could not load this trace', description: 'An unexpected error occurred.' };
}

export function TraceViewerPage() {
  const { correlationId } = useParams<{ correlationId: string }>();
  const id = correlationId ?? '';

  // 08-OBSERVABILITY.md §6 / `trace.controller.ts`: `super_admin` only, and — unlike every other
  // guarded route in `router.tsx` — not a `role_entity_permissions` row a Super Admin could grant
  // to someone else. `RequirePermission` is therefore the wrong guard here (there is, correctly,
  // no `trace` row in that matrix for *any* role, which would 403 a Super Admin too); this checks
  // the role directly, the same static check `@Roles('super_admin')` makes server-side.
  // `enabled: isSuperAdmin` below is this route's equivalent of `RequirePermission`'s "no data
  // request fired" property (T-020 TC-8) — the query never runs for a role that cannot use it.
  const { user } = useBootstrap();
  const isSuperAdmin = user?.role === 'super_admin';
  const { data, isLoading, isError, error, refetch } = useTrace(id, isSuperAdmin);

  if (!isSuperAdmin) {
    return <Forbidden />;
  }

  if (isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || data === undefined) {
    const { title, description } = errorMessage(error);
    return (
      <div className="p-6">
        <EmptyState
          icon={Ban}
          message={title}
          description={description}
          action={
            <button
              type="button"
              onClick={() => void refetch()}
              className="rounded-control bg-primary px-3 py-1.5 text-sm font-medium text-white"
            >
              Retry
            </button>
          }
        />
      </div>
    );
  }

  return <TraceViewerContent trace={data} />;
}

function TraceViewerContent({ trace }: { trace: TraceResponse }) {
  const [tab, setTab] = useState('timeline');
  const sourceEntries = useMemo(
    () => Object.entries(trace.sources) as [keyof TraceResponse['sources'], TraceSourceStatus][],
    [trace.sources],
  );

  return (
    <div className="p-6">
      <PageHeader
        title="Trace"
        description={trace.correlationId}
        actions={
          trace.truncated ? (
            <Badge tone="warning">
              Truncated at 5,000 rows — some data was left out of this view
            </Badge>
          ) : undefined
        }
      />

      <Card className="mb-4">
        <CardHeader className="flex flex-wrap items-center gap-2">
          {sourceEntries.map(([key, status]) => {
            const Icon = SOURCE_ICON[status];
            return (
              <Badge key={key} tone={SOURCE_TONE[status]} className="gap-1">
                <Icon className="size-3.5" aria-hidden="true" />
                {SOURCE_LABEL[key]}: {status.replace('_', ' ')}
              </Badge>
            );
          })}
        </CardHeader>
        <CardBody>
          <SummaryGrid trace={trace} />
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              {
                value: 'timeline',
                label: `Timeline (${String(trace.spans.length)})`,
                panel: (
                  <SpanWaterfall spans={trace.spans} totalDurationMs={trace.summary.durationMs} />
                ),
              },
              {
                value: 'audit',
                label: `Audit events (${String(trace.auditEvents.length)})`,
                panel: <AuditEventsTable trace={trace} />,
              },
              {
                value: 'domain',
                label: `Campaign audit (${String(trace.domainAudit.length)})`,
                panel: <DomainAuditTable trace={trace} />,
              },
              {
                value: 'logs',
                label: 'Raw log lines',
                panel: <RawLogLines trace={trace} />,
              },
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
}

function SummaryGrid({ trace }: { trace: TraceResponse }) {
  const { summary } = trace;

  if (summary.route === null && summary.startedAt === null) {
    return (
      <p className="text-sm text-slate-500">
        No request-completion log line was found for this correlation id — the summary and timeline
        could not be reconstructed, but the audit rows below are still shown.
      </p>
    );
  }

  const fields: [string, string][] = [
    ['Route', summary.route ?? '—'],
    ['Status', summary.status === null ? '—' : String(summary.status)],
    ['Started at', summary.startedAt ?? '—'],
    ['Duration', summary.durationMs === null ? '—' : `${String(summary.durationMs)}ms`],
    [
      'Actor',
      summary.actor === null
        ? '—'
        : `${summary.actor.role ?? 'unknown role'} (user ${String(summary.actor.userId ?? '—')})`,
    ],
    [
      'Scope',
      summary.scope === null
        ? '—'
        : `country ${String(summary.scope.countryId ?? '—')} · tenant ${String(
            summary.scope.tenantId ?? '—',
          )} · merchant ${String(summary.scope.merchantId ?? '—')}`,
    ],
  ];

  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-3">
      {fields.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
          <dd className="mt-0.5 text-slate-800">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AuditEventsTable({ trace }: { trace: TraceResponse }) {
  if (trace.auditEvents.length === 0) {
    return (
      <EmptyState
        message="No portal audit events"
        description="Nothing in reward_portal.portal_audit_log matched this correlation id."
      />
    );
  }

  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">Portal audit log rows for this correlation id</caption>
      <thead>
        <tr className="border-b border-slate-200 bg-slate-50 text-left">
          <th scope="col" className="px-3 py-2 font-medium text-slate-600">
            Occurred
          </th>
          <th scope="col" className="px-3 py-2 font-medium text-slate-600">
            Event
          </th>
          <th scope="col" className="px-3 py-2 font-medium text-slate-600">
            Actor
          </th>
          <th scope="col" className="px-3 py-2 font-medium text-slate-600">
            Target
          </th>
        </tr>
      </thead>
      <tbody>
        {trace.auditEvents.map((event) => (
          <tr key={event.id} className="border-b border-slate-100 last:border-b-0">
            <td className="px-3 py-2 text-slate-600">{event.occurredAt}</td>
            <td className="px-3 py-2 font-mono text-xs text-slate-800">{event.eventType}</td>
            <td className="px-3 py-2 text-slate-600">
              {event.actorRole ?? '—'} {event.actorId !== null && `(#${String(event.actorId)})`}
            </td>
            <td className="px-3 py-2 text-slate-600">
              {event.targetType ?? '—'} {event.targetId !== null && `#${event.targetId}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** TC-19 — a trace with no domain audit rows still renders this section, with its own empty state. */
function DomainAuditTable({ trace }: { trace: TraceResponse }) {
  if (trace.domainAudit.length === 0) {
    return (
      <EmptyState
        message="No campaign audit rows"
        description="Nothing in reward_config.campaign_audit_trail matched this correlation id."
      />
    );
  }

  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">Campaign audit trail rows for this correlation id</caption>
      <thead>
        <tr className="border-b border-slate-200 bg-slate-50 text-left">
          <th scope="col" className="px-3 py-2 font-medium text-slate-600">
            Performed
          </th>
          <th scope="col" className="px-3 py-2 font-medium text-slate-600">
            Action
          </th>
          <th scope="col" className="px-3 py-2 font-medium text-slate-600">
            Campaign
          </th>
          <th scope="col" className="px-3 py-2 font-medium text-slate-600">
            Approval request
          </th>
        </tr>
      </thead>
      <tbody>
        {trace.domainAudit.map((row) => (
          <tr key={row.id} className="border-b border-slate-100 last:border-b-0">
            <td className="px-3 py-2 text-slate-600">{row.performedAt}</td>
            <td className="px-3 py-2 font-mono text-xs text-slate-800">{row.action}</td>
            <td className="px-3 py-2">
              <CampaignLink campaignId={row.campaignId} />
            </td>
            <td className="px-3 py-2">
              {row.approvalRequestId === null ? (
                '—'
              ) : (
                <ApprovalRequestLink approvalRequestId={row.approvalRequestId} />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RawLogLines({ trace }: { trace: TraceResponse }) {
  if (trace.sources.logStore !== 'available') {
    return (
      <EmptyState
        message={
          trace.sources.logStore === 'not_configured'
            ? 'No log store is configured'
            : 'The log store is unavailable right now'
        }
        description="Every other source above is still complete — the log store is the one piece missing (08-OBSERVABILITY.md §6: missing sources degrade gracefully)."
      />
    );
  }

  if (trace.logLines === null || trace.logLines.length === 0) {
    return (
      <EmptyState
        message="No log lines"
        description="The log store answered, but had nothing for this id."
      />
    );
  }

  return (
    <pre className="max-h-96 overflow-auto rounded-control bg-slate-900 p-3 text-xs text-slate-100">
      {trace.logLines.map((line) => JSON.stringify(line)).join('\n')}
    </pre>
  );
}
