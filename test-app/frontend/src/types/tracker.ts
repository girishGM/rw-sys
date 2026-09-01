/**
 * T-006 — mirrors `tracking-service`'s `portal-client/types.ts` `TrackerCompletionLogic` (in turn
 * the real `reward_config` column, per `ARCHITECTURE.md` §3). Split into its own file so both
 * `campaign.ts` and `dashboard.ts` can import it without one depending on the other.
 */
export const TRACKER_COMPLETION_LOGICS = ['all', 'any', 'n_of'] as const;
export type TrackerCompletionLogic = (typeof TRACKER_COMPLETION_LOGICS)[number];
