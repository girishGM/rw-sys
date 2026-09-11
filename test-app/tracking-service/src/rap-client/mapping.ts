/**
 * Maps this app's own `POST /api/activities` request fields onto RAP's real `SubmitActivity`
 * wire shape (`../proto/activity_ingest.proto`). Pure and side-effect free so it's unit-testable
 * without a client or a mock gRPC channel — same split `portal-client/mapping.ts` already
 * established for that client's own inbound/outbound shape translation.
 *
 * test-app's own data model has no concept matching several of RAP's *required* fields
 * (`customerIdType`, `activityCategory`, `activityValueUnit`, `channel`, `activityPerformedEnv`) —
 * RAP's real controller (`activity-ingest.controller.ts`) rejects an empty string for every one of
 * them with `INVALID_ARGUMENT`, so each is filled with a fixed, documented constant below rather
 * than left blank. `activityType` (this app's one real, human-entered field) is always sent as
 * `activityName`; `activityCode` prefers the real, machine-readable code
 * (`routes/activities.ts`'s `matchedActivityCode`, sourced from the portal's own
 * `reward_config.activities.activity_code` via `portal-client`) once this submission actually
 * matched a real component, and only falls back to `activityType` when nothing matched yet (no
 * real code is known) — RAP's own campaign cache matches on the real code, not the display label,
 * so sending the label there was a genuine bug (found live: RAP received every activity but
 * matched nothing, even once its cache held the real campaign data).
 */
import type { SubmitActivityRequest } from './types';

export const RAP_CUSTOMER_ID_TYPE = 'EXTERNAL_ID';
export const RAP_ACTIVITY_CATEGORY = 'GENERAL';
export const RAP_ACTIVITY_VALUE_UNIT = 'USD';
export const RAP_CHANNEL = 'test-app-tracking-service';
export const RAP_ACTIVITY_PERFORMED_ENV = 'test-app-demo';

export interface ActivityForRap {
  /** This app's own generated activity id (`routes/activities.ts`'s `activityId`) — reused as
   * both `activityEventId` (idempotency) and `correlationId` (tracing), since this app has only
   * the one id per submitted activity. */
  readonly activityId: string;
  readonly customerId: string;
  readonly activityType: string;
  /** The real, machine-readable code of whichever component this submission actually matched
   * (`routes/activities.ts`'s `matchedActivityCode`), or `null` if nothing matched yet. */
  readonly activityCode: string | null;
  readonly merchant: string | null;
  readonly amount: number | null;
  /** T-INT-054 — this app's own real portal `tenantId` (`PortalCampaign.tenantId`), resolved by
   * `routes/activities.ts` from whichever real campaign is already on hand for this call, same
   * "no per-customer tenant id anywhere in this app's own model" sourcing `rap-progress-client`'s
   * `routes/dashboard.ts` call site already established for the identical problem. `null` when no
   * real campaign is currently resolvable — `toSubmitActivityRequest` below simply omits
   * `tenantId` in that case, which only matters if the REST transport ends up selected (gRPC never
   * reads it); see `rest.client.ts`'s own local validation for what happens then. */
  readonly tenantId: number | null;
}

export function toSubmitActivityRequest(activity: ActivityForRap): SubmitActivityRequest {
  return {
    tenantId: activity.tenantId ?? undefined,
    customerId: activity.customerId,
    customerIdType: RAP_CUSTOMER_ID_TYPE,
    // Full ISO-8601 with an explicit "Z" offset — Date#toISOString always produces one, satisfying
    // RAP's own "must carry an explicit offset" requirement without any extra formatting here.
    activityPerformedDate: new Date().toISOString(),
    activityCode: activity.activityCode ?? activity.activityType,
    activityType: activity.activityType,
    activityCategory: RAP_ACTIVITY_CATEGORY,
    activityValue: activity.amount !== null ? String(activity.amount) : '0',
    activityValueUnit: RAP_ACTIVITY_VALUE_UNIT,
    channel: RAP_CHANNEL,
    activityPerformedEnv: RAP_ACTIVITY_PERFORMED_ENV,
    activityName: activity.activityType,
    merchantCode: activity.merchant ?? undefined,
    activityEventId: activity.activityId,
    correlationId: activity.activityId,
  };
}
