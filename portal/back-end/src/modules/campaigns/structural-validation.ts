/**
 * T-037 implementation note 19 — structural validation before submit.
 *
 * > *"Every tracker has ≥ 1 component; every component has an activity and ≥ 1 rule; `n_of`
 * > threshold ≤ component count; every rule has all required parameter values; at least one
 * > reward exists somewhere."*
 *
 * ### Why these are 422s at submit rather than 400s at write time
 *
 * Because every one of them is **true of every campaign at some point while it is being built**.
 * A tracker has no components for the seconds between creating it and adding the first one; a
 * component has no rules until step 4. Rejecting those states would make the wizard fight the
 * maker mid-thought, and implementation note 12 asks for the opposite — *"draft saved after every
 * step … so a lost tab never costs a built structure"*.
 *
 * So the rule is: **a draft may be incomplete; a submission may not.** The one exception is the
 * `n_of` threshold, which `journey.service.ts` also refuses at write time — it is included here
 * too because a campaign could have been drafted before that check existed, and because
 * belt-and-braces on the trap the task file calls out by name (TC-21e) is cheap.
 *
 * ### Every problem at once, not the first one
 *
 * The function returns a **list**. Step 7 shows the maker everything that is wrong in one pass;
 * a validator that threw on the first problem would turn a five-problem campaign into five
 * round trips, each revealing one more thing. The submit path turns the same list into a single
 * 422 whose `details` carry the same entries (TC-21i, TC-21j, TC-21o).
 */
import type { RuleParameters, StructuralIssue } from '@reward-portal/shared';
import { missingRequiredParameterKeys } from '@reward-portal/shared';

/** One tracker, reduced to what the check needs. */
export interface TrackerShape {
  readonly id: number;
  readonly completionLogic: string;
  readonly completionThreshold: number | null;
  readonly componentIds: readonly number[];
}

/** One component, reduced to what the check needs. */
export interface ComponentShape {
  readonly id: number;
  readonly activityId: number | null;
  readonly rules: readonly {
    readonly parameters: RuleParameters;
    readonly values: Record<string, unknown>;
  }[];
}

export interface StructureInput {
  readonly trackers: readonly TrackerShape[];
  readonly components: readonly ComponentShape[];
  readonly merchantCount: number;
  readonly rewardCount: number;
}

/**
 * Every structural problem with `input`, in a stable order — campaign-wide first, then per
 * tracker, then per component, so step 7 reads top-down like the wizard itself.
 */
export function validateStructure(input: StructureInput): readonly StructuralIssue[] {
  const issues: StructuralIssue[] = [];
  const componentById = new Map(input.components.map((component) => [component.id, component]));

  // --- campaign-wide -------------------------------------------------------------------------

  if (input.merchantCount === 0) {
    // Not named in note 19's list, but implied by note 8: every component's activity must be
    // offered by a merchant chosen in step 2, so a campaign with no merchants can have no valid
    // component either. Reporting it directly is far more useful than reporting it once per
    // component as "activity not offered".
    issues.push({ code: 'CAMPAIGN_HAS_NO_MERCHANT', trackerId: null, componentId: null });
  }

  if (input.trackers.length === 0) {
    issues.push({ code: 'CAMPAIGN_HAS_NO_TRACKER', trackerId: null, componentId: null });
  }

  if (input.rewardCount === 0) {
    // TC-21o. A campaign that can never pay anything is the most expensive kind of valid-looking
    // configuration: it runs, it tracks, customers complete it, and nobody is rewarded.
    issues.push({ code: 'CAMPAIGN_HAS_NO_REWARD', trackerId: null, componentId: null });
  }

  // --- per tracker ---------------------------------------------------------------------------

  for (const tracker of input.trackers) {
    if (tracker.componentIds.length === 0) {
      // TC-21j — a tracker with no components can never complete.
      issues.push({ code: 'TRACKER_HAS_NO_COMPONENT', trackerId: tracker.id, componentId: null });
      continue;
    }

    if (tracker.completionLogic === 'n_of') {
      const threshold = tracker.completionThreshold;
      if (threshold === null || threshold < 1 || threshold > tracker.componentIds.length) {
        // TC-21e. The trap: a threshold above the count looks entirely valid on screen.
        issues.push({
          code: 'THRESHOLD_ABOVE_COMPONENT_COUNT',
          trackerId: tracker.id,
          componentId: null,
        });
      }
    }

    for (const componentId of tracker.componentIds) {
      const component = componentById.get(componentId);
      if (component === undefined) continue;

      if (component.activityId === null) {
        issues.push({
          code: 'COMPONENT_HAS_NO_ACTIVITY',
          trackerId: tracker.id,
          componentId,
        });
      }

      if (component.rules.length === 0) {
        // TC-21i, the second trap the task file names: *"a component with no rule can never
        // complete"*, and therefore neither can the tracker above it.
        issues.push({ code: 'COMPONENT_HAS_NO_RULE', trackerId: tracker.id, componentId });
        continue;
      }

      const incomplete = component.rules.some(
        (rule) => missingRequiredParameterKeys(rule.parameters, rule.values).length > 0,
      );
      if (incomplete) {
        // Note 19's *"every rule has all required parameter values"*. The values were validated
        // when they were bound, but a rule's own parameters can gain a required field in a later
        // version — so a binding that was complete when made may not be complete now.
        issues.push({ code: 'RULE_VALUES_INCOMPLETE', trackerId: tracker.id, componentId });
      }
    }
  }

  return issues;
}

/**
 * The `details` entries a 422 carries for `issues`.
 *
 * `field`/`code` both have to satisfy `SAFE_FIELD_PATTERN`/`SAFE_ERROR_CODE_PATTERN`
 * (`app-error.ts`), which is why the ids travel inside the **code** (`TRACKER_12`) rather than as
 * a free-form message: nothing a client receives is derived from the text of an error, and these
 * two patterns are what enforce that mechanically.
 */
export function structuralIssueDetails(
  issues: readonly StructuralIssue[],
): readonly { field: string; code: string }[] {
  return issues.map((issue) => ({
    field:
      issue.componentId !== null
        ? 'componentId'
        : issue.trackerId !== null
          ? 'trackerId'
          : 'campaignId',
    code: issue.code,
  }));
}
