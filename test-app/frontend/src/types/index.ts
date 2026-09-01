/** T-006 — barrel export for every type mirroring `tracking-service`'s contracts. */
export type { Customer } from './customer';
export {
  REWARD_TYPES,
  REWARD_STATUSES,
  type RewardType,
  type RewardStatus,
  type RewardLedgerEntry,
} from './reward';
export { TRACKER_COMPLETION_LOGICS, type TrackerCompletionLogic } from './tracker';
export type {
  RewardAssignment,
  TrackerProgressSummary,
  CampaignSummary,
  CampaignDetailComponent,
  CampaignDetailTracker,
  CampaignDetail,
} from './campaign';
export type {
  ActiveCampaignSummary,
  DashboardTrackerProgress,
  RewardCounts,
  DashboardSummary,
} from './dashboard';
export type {
  ActivityRequest,
  ProgressDelta,
  ActivityResult,
  ActivityHistoryEntry,
} from './activity';
export type { ProgressUpdatedPayload, RewardEarnedPayload } from './sse';
