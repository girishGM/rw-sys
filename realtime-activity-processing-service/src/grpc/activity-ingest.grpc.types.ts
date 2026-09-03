/**
 * T-RAP-022. Hand-written TypeScript shapes for `proto/activity_ingest.proto`'s messages, as
 * `@grpc/proto-loader` hands them to a handler at runtime — camelCase (proto-loader's default
 * `keepCase: false`, unchanged in `grpc-server.bootstrap.ts`'s loader options), every field a
 * `string` exactly as the `.proto` declares (`activity_value` is decimal-as-string, never a
 * numeric type). No code-generation step (`ts-proto` or similar) is wired into this project — same
 * "hand-in-sync with the `.proto` file" convention `promo-code.grpc.types.ts` already set for the
 * sibling project.
 */

export interface SubmitActivityRequestProto {
  customerId?: string;
  customerIdType?: string;
  activityPerformedDate?: string;
  transactionType?: string;
  activityCode?: string;
  activityType?: string;
  activityCategory?: string;
  activityValue?: string;
  activityValueUnit?: string;
  channel?: string;
  activityPerformedEnv?: string;
  activityName?: string;
  activityEventId?: string;
  correlationId?: string;
  merchantCode?: string;
}

export interface SubmitActivityResponseProto {
  correlationId: string;
  status: string;
  matchedTrackerComponents: string[];
}
