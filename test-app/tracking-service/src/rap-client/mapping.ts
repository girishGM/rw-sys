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
 * than left blank. `activityType` (this app's one real, human-entered field) is reused for both
 * `activityCode` and `activityName` — this app has no separate machine-code vs. display-name pair,
 * only the one string a caller of `POST /api/activities` actually supplies (the same reasoning
 * `engine/evaluate.ts`'s own `findComponentToComplete` already documents for why it matches by
 * name rather than a numeric `activityId`).
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
  readonly merchant: string | null;
  readonly amount: number | null;
}

export function toSubmitActivityRequest(activity: ActivityForRap): SubmitActivityRequest {
  return {
    customerId: activity.customerId,
    customerIdType: RAP_CUSTOMER_ID_TYPE,
    // Full ISO-8601 with an explicit "Z" offset — Date#toISOString always produces one, satisfying
    // RAP's own "must carry an explicit offset" requirement without any extra formatting here.
    activityPerformedDate: new Date().toISOString(),
    activityCode: activity.activityType,
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
