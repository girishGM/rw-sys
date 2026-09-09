/**
 * T-INT-020. Hand-written TypeScript shapes for `proto/progress_query.v1.proto`'s messages, as
 * `@grpc/proto-loader` hands them to a handler at runtime — camelCase (proto-loader's default
 * `keepCase: false`, unchanged by this task's own `grpc-server.bootstrap.ts` edit), every numeric
 * field a plain `number` (`int32`), every optional-string field a plain `string` whose empty value
 * stands in for `null` (`progress_query.v1.proto`'s own header explains why). No code-generation
 * step (`ts-proto` or similar) is wired into this project — same "hand-in-sync with the `.proto`
 * file" convention `activity-ingest.grpc.types.ts` already set for the sibling contract.
 *
 * A `repeated` field with zero entries deserializes to `undefined` on this server's own loader
 * options (no `defaults: true` anywhere in `buildGrpcMicroserviceOptions()`), never `[]` — same
 * behaviour `activity-ingest.grpc.types.ts`'s own header documents for
 * `matched_tracker_components`. This is why every `components`/`trackers` field below is typed
 * optional (`?:`) even though the response-building code in `progress-query.controller.ts` always
 * supplies a real (possibly empty) array on the way out.
 */

export interface GetCampaignProgressRequestProto {
  customerId?: string;
  campaignCode?: string;
}

export interface GetTrackerProgressRequestProto {
  customerId?: string;
  campaignCode?: string;
  trackerCode?: string;
}

export interface ComponentProgressViewProto {
  componentCode: string;
  currentCount: number;
  requiredCount: number;
  isCompleted: boolean;
}

export interface TrackerProgressViewProto {
  trackerCode: string;
  /** Empty string means `null` (`progress.types.ts`'s own `completionLogic: string | null`). */
  completionLogic: string;
  isCompleted: boolean;
  /** Empty string means `null` (`progress.types.ts`'s own `completedAt: string | null`). */
  completedAt: string;
  componentsRequiredCount: number;
  componentsCompletedCount: number;
  components?: ComponentProgressViewProto[];
}

export interface CampaignProgressResponseProto {
  customerId: string;
  campaignCode: string;
  trackers?: TrackerProgressViewProto[];
}

export type TrackerProgressResponseProto = TrackerProgressViewProto & {
  customerId: string;
  campaignCode: string;
};
