/**
 * T-004 — the one piece of real business logic in this app (ARCHITECTURE.md §3 / this task's
 * implementation notes): given a tracker and an incoming activity type, decide which component
 * (if any) that activity completes, and whether the tracker's real `completionLogic`/
 * `completionThreshold` (`all|any|n_of`, from `data/progress.ts`, T-003) is now satisfied.
 *
 * Deliberately pure — no store writes, no network, no Express — so it's testable in isolation with
 * plain objects, per this task's implementation notes. The caller (routes/activities.ts) is the
 * only place that persists the result via `ProgressStore.setComponentCompletion`.
 */
import { isTrackerComplete, type TrackerProgress } from '../data/progress';

/** A tracker component, augmented with the real `activityId`/`activityName` metadata
 * (`portal-client`'s `PortalJourneyComponent`) that `data/progress.ts`'s own
 * `TrackerComponentProgress` does not carry — that metadata only exists in the portal journey
 * response, not in this service's own progress-store shape, so the route layer joins the two by
 * `componentId` before calling into this module (see `toEvaluableTracker` in
 * `routes/activities.ts`). */
export interface EvaluableComponent {
  readonly componentId: number;
  readonly componentCode: string;
  readonly componentName: string;
  readonly completed: boolean;
  readonly activityId: number | null;
  readonly activityName: string | null;
}

/** Same shape as {@link TrackerProgress}, with `components` swapped for the activity-aware
 * {@link EvaluableComponent} — every other field (including `completionLogic`/
 * `completionThreshold`) is exactly `data/progress.ts`'s own real, un-reinvented field. */
export interface EvaluableTracker extends Omit<TrackerProgress, 'components'> {
  readonly components: readonly EvaluableComponent[];
}

export interface TrackerActivityResult {
  /** The component this activity completed, or `null` if nothing on this tracker matched
   * (TC-12: a legitimate no-op, not an error). */
  readonly matchedComponentId: number | null;
  /** The tracker with `matchedComponentId` flipped to `completed: true` — identical to the input
   * tracker when nothing matched. */
  readonly updatedTracker: EvaluableTracker;
  readonly wasComplete: boolean;
  readonly isNowComplete: boolean;
  /** `isNowComplete && !wasComplete` — the only condition that should ever mint a new reward.
   * `false` for an activity on an already-complete tracker (TC-8's "no double award" case), even
   * though a component may still nominally get marked complete. */
  readonly justCompleted: boolean;
}

function normalizeActivityType(value: string): string {
  return value.trim().toLowerCase();
}

/** The first not-yet-completed component (in the tracker's own stored order — already
 * sequence-ordered by `data/seed.ts`, T-003) whose real `activityName` matches `activityType`,
 * case/whitespace-insensitively. Matching by name (not `activityId`) because that is the one
 * human-readable identifier a caller of `POST /api/activities` actually has — see this task's
 * completion report for why `activityId` alone isn't usable here. */
export function findComponentToComplete(
  tracker: EvaluableTracker,
  activityType: string,
): EvaluableComponent | null {
  const normalized = normalizeActivityType(activityType);
  if (normalized.length === 0) return null;

  return (
    tracker.components.find(
      (component) =>
        !component.completed &&
        component.activityName !== null &&
        normalizeActivityType(component.activityName) === normalized,
    ) ?? null
  );
}

/** Evaluates one activity against one tracker. Reuses `data/progress.ts`'s own real
 * `isTrackerComplete` (T-003) for both the "before" and "after" completion check, rather than
 * re-deriving `all|any|n_of` semantics here — that module's docstring names this exact split of
 * responsibility. */
export function evaluateTrackerActivity(
  tracker: EvaluableTracker,
  activityType: string,
): TrackerActivityResult {
  const wasComplete = isTrackerComplete(tracker);
  const matched = findComponentToComplete(tracker, activityType);

  if (matched === null) {
    return {
      matchedComponentId: null,
      updatedTracker: tracker,
      wasComplete,
      isNowComplete: wasComplete,
      justCompleted: false,
    };
  }

  const updatedTracker: EvaluableTracker = {
    ...tracker,
    components: tracker.components.map((component) =>
      component.componentId === matched.componentId ? { ...component, completed: true } : component,
    ),
  };
  const isNowComplete = isTrackerComplete(updatedTracker);

  return {
    matchedComponentId: matched.componentId,
    updatedTracker,
    wasComplete,
    isNowComplete,
    justCompleted: isNowComplete && !wasComplete,
  };
}
