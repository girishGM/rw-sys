/**
 * T-RAP-040. Response-shape contracts for the customer progress API (`01-DATABASE.md` §4-§5,
 * task `Implementation notes` point 3: "everything needed to render a progress bar without a
 * second call"). Plain, transport-agnostic interfaces — `progress.controller.ts` returns these
 * directly, Nest's own `ClassSerializerInterceptor` is not used anywhere in this module (no
 * decorators needed for a read-only, already-shaped plain object).
 */

export interface ComponentProgressView {
  componentCode: string;
  currentCount: number;
  requiredCount: number;
  isCompleted: boolean;
}

export interface TrackerProgressView {
  trackerCode: string;
  /** `null` when this tracker's own campaign snapshot is missing/stale locally (implementation
   * note 1's own cache-miss reality — never blocks the response, `05-PROCESSING-PIPELINE.md`'s
   * "surfaces the already-materialized result" scope still holds for the progress numbers
   * themselves). */
  completionLogic: string | null;
  isCompleted: boolean;
  completedAt: string | null;
  componentsRequiredCount: number;
  componentsCompletedCount: number;
  components: ComponentProgressView[];
}

export interface CampaignProgressResponse {
  customerId: string;
  campaignCode: string;
  trackers: TrackerProgressView[];
}

export type TrackerProgressResponse = TrackerProgressView & {
  customerId: string;
  campaignCode: string;
};
