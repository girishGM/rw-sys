/**
 * T-008 — the Trackers section's own copy of a tracker's real `completion_logic` (this task's
 * Scope: "correctly reflecting the tracker's real `completion_logic` — e.g. 'Requires ALL
 * components' copy only when the real logic is `all`"). `threshold`/`componentCount` only matter
 * for `n_of` — the other two cases read as plain English regardless of how many components exist,
 * since "requires all" and "requires any" are already unambiguous without a number.
 */
import type { TrackerCompletionLogic } from '../../types';

export function completionLogicCopy(
  logic: TrackerCompletionLogic,
  threshold: number | null,
  componentCount: number,
): string {
  switch (logic) {
    case 'all':
      return 'Requires ALL components';
    case 'any':
      return 'Requires ANY ONE component';
    case 'n_of':
      return `Requires ${threshold ?? componentCount} of ${componentCount} components`;
  }
}
