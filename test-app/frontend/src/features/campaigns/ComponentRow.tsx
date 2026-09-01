/**
 * T-008 — one component of a tracker's real breakdown (this task's Scope: "the Trackers section
 * broken down by component (icon, name, ... complete/not-complete state)"). `component` is
 * `GET /api/campaigns/:code`'s own `CampaignDetailComponent` — `completed` is already evaluated
 * server-side against the selected customer's real progress (or `false` when no customer is
 * selected), never re-derived here.
 */
import { CheckCircleIcon } from '../../components/icons';
import type { CampaignDetailComponent } from '../../types';

export interface ComponentRowProps {
  component: CampaignDetailComponent;
}

export function ComponentRow({ component }: ComponentRowProps) {
  return (
    <li className="flex items-center gap-3">
      {component.completed ? (
        <CheckCircleIcon aria-hidden="true" className="h-5 w-5 shrink-0 text-accent-strong" />
      ) : (
        <span aria-hidden="true" className="h-5 w-5 shrink-0 rounded-full border-2 border-border" />
      )}
      <span
        className={`font-body text-sm ${
          component.completed ? 'font-medium text-ink' : 'text-ink-muted'
        }`}
      >
        {component.componentName}
      </span>
      {!component.isMandatory && (
        <span className="font-body text-xs text-ink-muted">(optional)</span>
      )}
    </li>
  );
}
