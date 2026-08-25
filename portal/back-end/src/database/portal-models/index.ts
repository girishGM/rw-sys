/**
 * T-003 — barrel of every `reward_portal`-schema Sequelize model. Consumed by
 * `sequelize.provider.ts` to populate the `models: [...]` list on the one shared
 * connection, and by the schema-drift test to enumerate what to check.
 *
 * `PortalUserNotification` (T-040 retry 1) is an additive registration-point append to this
 * otherwise T-003-owned barrel — same precedent `portal-audit-log.model.ts`'s own
 * `correlation_id` addition already established for a T-045 append to a T-003 file
 * (05-EXECUTION-PLAN.md §3, append-only). See `T040_001_portal_user_notifications.ts` for why
 * this table exists.
 */
export * from './portal-user.model';
export * from './portal-user-credential.model';
export * from './portal-session.model';
export * from './portal-refresh-token.model';
export * from './portal-login-attempt.model';
export * from './portal-password-reset.model';
export * from './portal-audit-log.model';
export * from './portal-user-role.model';
export * from './portal-user-notification.model';
// T-037 — the two portal-side replacements for `reward_config` tables whose actor foreign keys
// point at `admin_users` and therefore cannot hold a `maker`/`checker` (gap G1). Same
// append-only registration-point shape `PortalUserNotification` above already set; see
// `T037_001_portal_approval_requests.ts` and `T037_002_portal_campaign_audit_trail.ts`.
export * from './portal-approval-request.model';
export * from './portal-campaign-audit-trail.model';

import { PortalUser } from './portal-user.model';
import { PortalUserCredential } from './portal-user-credential.model';
import { PortalSession } from './portal-session.model';
import { PortalRefreshToken } from './portal-refresh-token.model';
import { PortalLoginAttempt } from './portal-login-attempt.model';
import { PortalPasswordReset } from './portal-password-reset.model';
import { PortalAuditLog } from './portal-audit-log.model';
import { PortalUserRole } from './portal-user-role.model';
import { PortalUserNotification } from './portal-user-notification.model';
import { PortalApprovalRequest } from './portal-approval-request.model';
import { PortalCampaignAuditTrail } from './portal-campaign-audit-trail.model';

export const PORTAL_MODELS = [
  PortalUser,
  PortalUserCredential,
  PortalSession,
  PortalRefreshToken,
  PortalLoginAttempt,
  PortalPasswordReset,
  PortalAuditLog,
  PortalUserRole,
  PortalUserNotification,
  PortalApprovalRequest,
  PortalCampaignAuditTrail,
];
