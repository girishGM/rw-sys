/**
 * T-RAP-032. The tracker-level completion evaluator — a pure function of the cached tracker's own
 * `completion_logic`/`completion_threshold` (`03-GRPC-CONTRACT.md` §2 `Tracker`, `01-DATABASE.md`
 * §5) plus the current tally, exactly mirroring `rule-evaluator.service.ts`'s own "no DB access, no
 * cache access of its own" discipline so the same tally can be re-evaluated identically on a
 * crash-and-retry.
 *
 * `05-PROCESSING-PIPELINE.md` §5 point 2 names three supported values:
 *  - `all`   — every component under the tracker must be complete: `completedCount >= requiredCount`
 *    (`requiredCount` here is the tracker's own total component membership, not
 *    `completion_threshold` — see `tracker-status.repository.ts`'s own header for how the caller
 *    resolves that denominator from the cache).
 *  - `any`   — at least one: `completedCount >= 1`.
 *  - `n_of`  — `completedCount >= completion_threshold`.
 *
 * The proto's `Tracker.completion_logic` comment also lists a fourth value, `sequence` — genuinely
 * out of scope here (`05-PROCESSING-PIPELINE.md` §5 point 2 names only these three, and this task's
 * own Objective quotes the same three). A tracker configured with `sequence` is a genuine
 * configuration state this evaluator cannot yet interpret — `isComplete` throws for it, the same
 * "malformed/unsupported input is a configuration defect, not a normal outcome" discipline
 * `rule-evaluator.service.ts` already established, never a silent guess at semantics nobody
 * specified.
 */
import { Injectable } from '@nestjs/common';

export interface TrackerCompletionInput {
  completionLogic: string;
  completionThreshold: number;
  /** Total component membership under this tracker (`tracker.components.length` in the cache),
   * used as the `all` logic's own denominator — see this file's own header. */
  componentsRequiredCount: number;
  componentsCompletedCount: number;
}

@Injectable()
export class TrackerCompletionEvaluatorService {
  isComplete(input: TrackerCompletionInput): boolean {
    switch (input.completionLogic) {
      case 'all':
        return input.componentsCompletedCount >= input.componentsRequiredCount;
      case 'any':
        return input.componentsCompletedCount >= 1;
      case 'n_of':
        return input.componentsCompletedCount >= input.completionThreshold;
      default:
        throw new Error(
          `Unsupported tracker completion_logic "${input.completionLogic}" — only "all", "any" ` +
            'and "n_of" are implemented (05-PROCESSING-PIPELINE.md §5 point 2).',
        );
    }
  }
}
