/**
 * T-038 implementation note 7 — *"the diff view renders `approval_requests.payload` against the
 * current entity. Malformed payload → a readable 'cannot render diff' state, never a crash on a
 * checker's queue."*
 *
 * ### This function cannot throw, and that is the whole specification
 *
 * `portal_approval_requests.payload` is `jsonb`, so it always parses — but nothing constrains its
 * *shape*. A row written by an older build, by a future entity type, or by hand can be a scalar,
 * an array, `null`, or an object whose `name` is a number. A checker's queue is a list, so one
 * such row must not be able to take the whole page down with it: every branch below produces a
 * value, none of them produces an exception, and `buildApprovalDiff` has no `throw` in it at all
 * (TC-20).
 *
 * The failure is reported rather than hidden: `problem` names *why* a before/after comparison was
 * impossible, and `skippedFields` names each individual field that had an uncomparable value, so
 * a checker looking at a half-rendered diff knows it is half-rendered.
 *
 * ### What is compared, and why dates are compared as instants
 *
 * T-037's `submit` writes the four scalar campaign fields below plus budget/count context. The
 * scalars are compared to the campaign **as it stands now**; the context is passed through
 * untouched (implementation note 18 put `percentOfCeiling` in the payload precisely so a checker
 * would not have to do arithmetic).
 *
 * `startDate`/`endDate` are compared as **calendar days**, not as text and not as instants
 * (T-065). Both sides are reduced to `YYYY-MM-DD` first, because the same day can reach this
 * function written several ways: a payload written after T-065 holds `2027-02-15`, one written
 * before it holds `2027-02-15T18:29:59.000Z`, and a maker may have submitted `+08:00`. The same
 * day written two ways is not a change, and a diff that claims otherwise puts a spurious row in
 * every single comparison — the fastest way to teach a checker to ignore the diff entirely.
 *
 * Showing days rather than instants is also what makes this screen agree with the wizard the
 * maker submitted from: T-065 TC-7 is exactly *"approval diff and campaign list show the same
 * date the wizard showed"*.
 *
 * Kept a pure function of two arguments so it is unit-testable without a database, a request or a
 * Nest container — the same shape `structural-validation.ts` and `budget-analysis.ts` (T-037) use.
 */
import type {
  ApprovalBudgetLine,
  ApprovalDiff,
  ApprovalDiffField,
  ApprovalDiffProblem,
} from '@reward-portal/shared';
import { calendarDateOf, toCalendarDate } from '@/modules/campaigns/campaign-date';

/** The entity side of the comparison. Only the fields the payload records. */
export interface DiffSubject {
  readonly campaignCode: string;
  readonly name: string;
  readonly startDate: Date;
  readonly endDate: Date;
}

interface ComparableField {
  readonly key: string;
  readonly label: string;
  readonly current: (subject: DiffSubject) => string;
  /** Whether two textual values mean the same thing. Defaults to strict equality. */
  readonly equals?: (payloadValue: string, currentValue: string) => boolean;
}

/** The four scalars `CampaignsService.submit` records in `payload`, in the order a checker reads
 * them (identity first, then the dates that decide when money moves). */
const COMPARABLE_FIELDS: readonly ComparableField[] = Object.freeze([
  { key: 'campaignCode', label: 'Campaign code', current: (s) => s.campaignCode },
  { key: 'name', label: 'Name', current: (s) => s.name },
  {
    key: 'startDate',
    label: 'Start date',
    current: (s) => calendarDateOf(s.startDate),
    equals: sameDay,
  },
  {
    key: 'endDate',
    label: 'End date',
    current: (s) => calendarDateOf(s.endDate),
    equals: sameDay,
  },
]);

/** An empty, honest diff — the value every early return below produces. */
function emptyDiff(problem: ApprovalDiffProblem | null): ApprovalDiff {
  return {
    renderable: false,
    problem,
    changed: [],
    unchangedCount: 0,
    skippedFields: [],
    budgets: [],
    warnings: [],
    trackerCount: null,
    componentCount: null,
  };
}

/**
 * Builds the checker's diff. Never throws — see this file's header.
 *
 * `subject` is `null` when the campaign the request names has been removed, or is outside the
 * caller's scope. That is not an error: the request row itself is still governance evidence and
 * must remain readable, so the diff degrades to `SUBJECT_UNAVAILABLE` and the payload's own
 * context is still shown.
 */
export function buildApprovalDiff(payload: unknown, subject: DiffSubject | null): ApprovalDiff {
  if (payload === null || payload === undefined) return emptyDiff('PAYLOAD_MISSING');
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return emptyDiff('PAYLOAD_NOT_AN_OBJECT');
  }

  const record = payload as Record<string, unknown>;
  const context = {
    budgets: readBudgets(record['budgets']),
    warnings: readStringArray(record['warnings']),
    trackerCount: readInteger(record['trackerCount']),
    componentCount: readInteger(record['componentCount']),
  };

  if (subject === null) {
    return { ...emptyDiff('SUBJECT_UNAVAILABLE'), ...context };
  }

  const changed: ApprovalDiffField[] = [];
  const skippedFields: string[] = [];
  let unchangedCount = 0;

  for (const field of COMPARABLE_FIELDS) {
    const submitted = record[field.key];
    if (submitted === undefined) {
      // Absent from the payload is not "changed to nothing" — there is simply nothing to
      // compare, and inventing a `before` of `null` would show a change that never happened.
      skippedFields.push(field.key);
      continue;
    }
    if (typeof submitted !== 'string') {
      skippedFields.push(field.key);
      continue;
    }

    const current = field.current(subject);
    const equal =
      field.equals === undefined ? submitted === current : field.equals(submitted, current);
    if (equal) {
      unchangedCount += 1;
      continue;
    }
    changed.push({ field: field.key, label: field.label, before: submitted, after: current });
  }

  return {
    renderable: true,
    problem: null,
    changed,
    unchangedCount,
    skippedFields,
    ...context,
  };
}

// --- tolerant readers ----------------------------------------------------------------------------
//
// Every one of these takes `unknown` and returns a well-typed value or a neutral default. None of
// them narrows by assertion, because an assertion is exactly the thing that turns a malformed row
// into a 500 two frames further down.

/**
 * Whether two campaign-date strings name the same calendar day (T-065).
 *
 * An unparseable value falls back to textual comparison rather than reporting "changed": a
 * payload this function cannot read is a payload it has nothing to say about, and inventing a
 * change out of it would put a row in the checker's diff that describes nothing that happened.
 */
function sameDay(a: string, b: string): boolean {
  try {
    return toCalendarDate(a) === toCalendarDate(b);
  } catch {
    return a === b;
  }
}

function readInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The `budgets` array T-037 writes, defensively read.
 *
 * A line missing `unitType`/`unitCode` is dropped rather than defaulted: a budget line labelled
 * with an invented unit is worse than no line at all on a screen whose purpose is to let somebody
 * approve a payout.
 */
function readBudgets(value: unknown): ApprovalBudgetLine[] {
  if (!Array.isArray(value)) return [];

  const lines: ApprovalBudgetLine[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const line = entry as Record<string, unknown>;
    const unitType = readString(line['unitType']);
    const unitCode = readString(line['unitCode']);
    if (unitType === null || unitCode === null) continue;

    lines.push({
      unitType,
      unitCode,
      campaignBudget: readString(line['campaignBudget']) ?? '0',
      maxCampaignBudget: readString(line['maxCampaignBudget']),
      percentOfCeiling:
        typeof line['percentOfCeiling'] === 'number' ? line['percentOfCeiling'] : null,
      state: readString(line['state']) ?? 'unknown',
    });
  }
  return lines;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
