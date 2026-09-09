/**
 * T-INT-021 — the wire shape of `realtime-activity-processing-service`'s ("RAP") real customer
 * progress API, both transports (`ProgressController`'s REST routes, T-RAP-040, and
 * `ProgressQueryService`'s gRPC equivalent, T-INT-020) — hand-declared here for the same reason
 * `rap-client/types.ts` hand-declares that service's `SubmitActivity` shape: this app has no
 * dependency on RAP's own workspace.
 *
 * Field names/shapes are copied straight from RAP's own `progress.types.ts`
 * (`CampaignProgressResponse`/`TrackerProgressView`/`ComponentProgressView`) — see this task's
 * own Implementation note 1: that response shape was itself designed in T-INT-020 to line up
 * field-for-field with this app's own `data/progress.ts` (`CampaignProgress`/`TrackerProgress`/
 * `TrackerComponentProgress`), swapping this app's numeric `campaignId`/`trackerId`/`componentId`
 * for RAP's own `campaignCode`/`trackerCode`/`componentCode` strings — a call site reconciles the
 * two by joining on the `*Code` fields against the campaign/tracker/component structure it already
 * holds (from `portal-client`/`ProgressStore`), never by inventing a second id scheme.
 */

export interface RapComponentProgress {
  readonly componentCode: string;
  readonly currentCount: number;
  readonly requiredCount: number;
  readonly isCompleted: boolean;
}

export interface RapTrackerProgress {
  readonly trackerCode: string;
  /** `null` when RAP's own campaign config snapshot is missing/stale locally for this tracker —
   * mirrors `progress.types.ts`'s `completionLogic: string | null` (empty string on the wire,
   * translated back to `null` by this client — see `rest.client.ts`/`grpc.client.ts`). */
  readonly completionLogic: string | null;
  readonly isCompleted: boolean;
  readonly completedAt: string | null;
  readonly componentsRequiredCount: number;
  readonly componentsCompletedCount: number;
  readonly components: readonly RapComponentProgress[];
}

export interface RapCampaignProgress {
  readonly customerId: string;
  readonly campaignCode: string;
  /** Empty when this customer has no materialized progress on this campaign yet — a normal, real
   * "hasn't started" response, never treated as "unknown" by a call site (RAP's own contract,
   * `progress_query.v1.proto`'s own header: "Empty `trackers` is a normal response"). */
  readonly trackers: readonly RapTrackerProgress[];
}

export interface GetCampaignProgressParams {
  readonly customerId: string;
  /** `ProgressApiTokenClaims.tenantId` — required to mint the bearer token RAP's
   * `ProgressApiAuthGuard`/`ProgressQueryController.authenticate` both verify (`token.ts`). Same
   * "resolved from whichever real campaign is on hand" sourcing this app's own
   * `reward-tracking-client` already established for the identical problem (there is no
   * per-customer tenant id anywhere in this app's own model — see `routes/dashboard.ts`). */
  readonly tenantId: number;
  readonly campaignCode: string;
}

export interface GetTrackerProgressParams extends GetCampaignProgressParams {
  readonly trackerCode: string;
}

/** The one interface both transports (`RapProgressRestClient`/`RapProgressGrpcClient`) and the
 * configurable selector (`ConfigurableRapProgressClient`) implement — so `from-env.ts` and tests
 * can treat all three identically. */
export interface RapProgressReader {
  getCampaignProgress(params: GetCampaignProgressParams): Promise<RapCampaignProgress>;
  getTrackerProgress(params: GetTrackerProgressParams): Promise<RapTrackerProgress>;
}
