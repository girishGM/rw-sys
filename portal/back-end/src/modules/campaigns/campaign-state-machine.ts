/**
 * T-037 implementation note 3 — the campaign lifecycle, *"as an explicit transition table"*.
 *
 * 03-API-CONTRACT.md §11:
 *
 * ```
 * draft ──submit──► pending_approval ──approve──► active ──pause──► paused ──resume──► active
 *   ▲                      │                         │                                   │
 *   └──────return──────────┤                         └──────────(end_date)──────► completed
 *   ◄──────reject──────────┘                                                             │
 *                                                                          archive ◄─────┘
 * ```
 *
 * ### Why a table rather than a switch
 *
 * A `switch (status)` in each of six methods is six places to forget a case, and the one that is
 * forgotten is always the one nobody exercises — `paused → archived`, say. A single frozen map
 * makes the whole lifecycle readable in one screen, makes an unlisted transition impossible by
 * construction rather than by review, and gives `campaigns.service.ts` exactly one line
 * (`assertTransition`) at every state change. TC-21 has no dedicated case for this, which is
 * precisely why it is worth making structural: an untested branch that cannot exist is safer
 * than an untested branch that can.
 *
 * ### `returned` is a presentation state, not a stored one
 *
 * The diagram above shows `returned`, and T-038 sends a campaign there for rework. The live
 * `ck_tc_status` CHECK permits only `draft`, `pending_approval`, `active`, `paused`, `completed`,
 * `archived` — and R1 forbids altering it. A returned campaign is therefore **stored** as
 * `draft`, with the fact of the return carried by its own approval request
 * (`portal_approval_requests.status = 'returned'` plus its `review_comment`), and **presented**
 * as `returned` by {@link effectiveStatus}. Every maker-visible behaviour the design asks for —
 * it comes back to me, with a comment, and I can edit it again — holds either way; what changes
 * is only which column carries the fact, and this is the only column choice R1 leaves available.
 * Documented as a deviation in the T-037 completion report.
 */
import { CAMPAIGN_STATUS } from './campaigns.constants';
import { CampaignTransitionNotAllowedError } from './campaigns.errors';

/** One of the six values `ck_tc_status` permits. */
export type CampaignStatus = (typeof CAMPAIGN_STATUS)[keyof typeof CAMPAIGN_STATUS];

/** The verbs the API exposes, one per arrow in the diagram above. */
export type CampaignTransition =
  'submit' | 'approve' | 'reject' | 'return' | 'pause' | 'resume' | 'complete' | 'archive';

/**
 * The whole lifecycle. Read it as *"from this status, this verb leads to that status"*; anything
 * absent is a 409.
 *
 * `reject` and `return` both land on `draft` — see this file's header. They differ in the
 * approval request's own recorded status, which is what the maker's banner and the checker's
 * history are built from, not in the campaign column.
 */
const TRANSITIONS: Readonly<
  Record<CampaignStatus, Readonly<Partial<Record<CampaignTransition, CampaignStatus>>>>
> = Object.freeze({
  [CAMPAIGN_STATUS.DRAFT]: Object.freeze({
    submit: CAMPAIGN_STATUS.PENDING_APPROVAL,
  }),
  [CAMPAIGN_STATUS.PENDING_APPROVAL]: Object.freeze({
    approve: CAMPAIGN_STATUS.ACTIVE,
    reject: CAMPAIGN_STATUS.DRAFT,
    return: CAMPAIGN_STATUS.DRAFT,
  }),
  [CAMPAIGN_STATUS.ACTIVE]: Object.freeze({
    pause: CAMPAIGN_STATUS.PAUSED,
    complete: CAMPAIGN_STATUS.COMPLETED,
  }),
  [CAMPAIGN_STATUS.PAUSED]: Object.freeze({
    resume: CAMPAIGN_STATUS.ACTIVE,
    complete: CAMPAIGN_STATUS.COMPLETED,
  }),
  [CAMPAIGN_STATUS.COMPLETED]: Object.freeze({
    archive: CAMPAIGN_STATUS.ARCHIVED,
  }),
  [CAMPAIGN_STATUS.ARCHIVED]: Object.freeze({}),
});

/**
 * The statuses in which a maker may still change a campaign's content.
 *
 * `draft` only — which, per this file's header, is also every returned campaign. Implementation
 * note 3's *"editing allowed only in `draft`/`returned`"* is therefore satisfied by this single
 * entry, not weakened by it.
 */
const EDITABLE_STATUSES: ReadonlySet<string> = new Set<string>([CAMPAIGN_STATUS.DRAFT]);

/** Whether `status` permits content edits. */
export function isEditable(status: string): boolean {
  return EDITABLE_STATUSES.has(status);
}

/** The status `transition` leads to from `from`, or `null` when the machine forbids it. */
export function nextStatus(from: string, transition: CampaignTransition): CampaignStatus | null {
  const row = TRANSITIONS[from as CampaignStatus];
  if (row === undefined) return null;
  return row[transition] ?? null;
}

/**
 * {@link nextStatus}, or a 409.
 *
 * Every state change in `campaigns.service.ts` goes through this rather than assigning a status
 * directly, so "which transitions are legal" is answered in one place and cannot drift between
 * the submit path and the pause path.
 */
export function assertTransition(from: string, transition: CampaignTransition): CampaignStatus {
  const to = nextStatus(from, transition);
  if (to === null) throw new CampaignTransitionNotAllowedError(from, transition);
  return to;
}

/**
 * What the UI shows: the stored status, or `returned` when the campaign is a `draft` whose last
 * approval decision was a return.
 *
 * `lastApprovalStatus` is the `status` of the campaign's most recent
 * `portal_approval_requests` row, or `null` when it has never been submitted.
 */
export function effectiveStatus(
  status: string,
  lastApprovalStatus: string | null,
): CampaignStatus | 'returned' {
  if (status === CAMPAIGN_STATUS.DRAFT && lastApprovalStatus === 'returned') return 'returned';
  return status as CampaignStatus;
}

/** Every transition legal from `status`. Exported for the tests and for a future UI that wants
 * to render available actions without hard-coding them. */
export function availableTransitions(status: string): readonly CampaignTransition[] {
  const row = TRANSITIONS[status as CampaignStatus];
  if (row === undefined) return [];
  return Object.keys(row) as CampaignTransition[];
}
