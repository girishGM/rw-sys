/**
 * The wire shape of `realtime-activity-processing-service`'s real `SubmitActivity` gRPC RPC
 * (`../proto/activity_ingest.proto`, a local copy of that service's own authoritative
 * `proto/activity_ingest.proto` — see that file's header). Hand-declared here for the same reason
 * `promo-code-client/types.ts` hand-declares that service's REST shapes: this app has no
 * dependency on RAP's own workspace. Field names are camelCase — `@grpc/proto-loader` is loaded
 * with `keepCase: false` in `client.ts`, matching RAP's own `grpc-server.bootstrap.ts` loader
 * options and its hand-written `activity-ingest.grpc.types.ts` mirror of this same message.
 */

export interface SubmitActivityRequest {
  readonly customerId: string;
  readonly customerIdType: string;
  /** Full ISO-8601 with an explicit zone offset, e.g. `"2026-09-01T10:15:30Z"` — RAP's own
   * `activity-ingest.validation.ts` rejects a timestamp with no offset. */
  readonly activityPerformedDate: string;
  /** One of `transactionType`/`activityCode` is required — RAP's controller rejects a request
   * with neither set. */
  readonly transactionType?: string;
  readonly activityCode?: string;
  readonly activityType: string;
  readonly activityCategory: string;
  /** Decimal-as-string, e.g. `"12.5"` — never a JS `number`, avoiding float precision loss over
   * the wire (the same convention RAP's own proto documents for this field). */
  readonly activityValue: string;
  readonly activityValueUnit: string;
  readonly channel: string;
  readonly activityPerformedEnv: string;
  readonly activityName: string;
  /** OPTIONAL but strongly recommended by RAP's own proto — used here for idempotency dedup. */
  readonly activityEventId?: string;
  /** OPTIONAL — RAP generates one itself if left blank. */
  readonly correlationId?: string;
  readonly merchantCode?: string;
}

export interface SubmitActivityResponse {
  readonly correlationId: string;
  /** `"accepted"` | `"duplicate"` in practice — never a per-tracker-component outcome (RAP's own
   * proto comment: this RPC is fire-and-forget beyond acknowledgment of receipt). */
  readonly status: string;
  readonly matchedTrackerComponents: readonly string[];
}
