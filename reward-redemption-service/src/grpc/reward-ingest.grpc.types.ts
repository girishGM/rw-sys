/**
 * T-RR-011. Hand-written TypeScript shapes for `proto/reward_ingest.proto`'s messages, as
 * `@grpc/proto-loader` hands them to a handler at runtime — camelCase (proto-loader's default
 * `keepCase: false`, unchanged in `grpc-server.bootstrap.ts`'s loader options), every field a
 * `string` exactly as the `.proto` declares (`activity_value`/`reward_value` are decimal-as-string,
 * never a numeric type; `tenant_id`/`completion_cycle` are the proto's only two `int32` fields).
 * No code-generation step (`ts-proto` or similar) is wired into this project — same
 * "hand-in-sync with the `.proto` file" convention RAP's own `activity-ingest.grpc.types.ts`
 * already set for the sibling project.
 */

export interface RewardEntryProto {
  id?: string;
  correlationId?: string;
  tenantId?: number;
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
  campaignCode?: string;
  trackerCode?: string;
  trackerComponentCode?: string;
  merchantCode?: string;
  rewardCode?: string;
  rewardCategory?: string;
  rewardValue?: string;
  rewardValueUnit?: string;
  rewardEntryDate?: string;
  completionCycle?: number;
}

export interface SubmitRewardEntryAckProto {
  rewardEntryId: string;
  status: string;
}
