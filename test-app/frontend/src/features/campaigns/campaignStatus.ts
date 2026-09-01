/**
 * T-008 — maps a campaign's real portal status (`portal/back-end`'s `tenant_campaigns.status`,
 * passed through unchanged by `tracking-service`) to one of `Badge`'s 3 tones
 * (`UI-UX-DESIGN.md` "Core components": "active/unused = accent ... ends-soon/expiring = warn ...
 * used/inactive = muted"). The set of statuses this app's own `GET /api/v1/campaigns` route can
 * ever return is `active | paused | completed` (`portal/back-end`'s own
 * `MERCHANT_VISIBLE_CAMPAIGN_STATUSES` narrowing) — `paused` reads as "needs attention" (warn),
 * `completed` as inactive (muted), anything else falls back to muted rather than crashing on a
 * status this app has never seen.
 */
import type { BadgeTone } from '../../components/Badge';

export function campaignStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'active':
      return 'accent';
    case 'paused':
      return 'warn';
    default:
      return 'muted';
  }
}
