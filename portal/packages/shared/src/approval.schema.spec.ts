/**
 * T-038 — the `/approvals` wire contract.
 *
 * Same discipline as every other `*.schema.spec.ts` in this package: prove the schemas are
 * `.strict()` in both directions (a missing field and an extra field both fail), and prove the two
 * exported helpers — which the server and the SPA *share*, so they cannot disagree about a
 * boundary — behave identically at every edge.
 *
 * `isApprovalExpired` is the one worth reading twice. It is what lets a checker's open browser tab
 * and the server's decision path reach the same verdict about a request whose deadline passed
 * while nobody was looking (TC-13, TC-14).
 */
import {
  APPROVAL_ACTIONS,
  APPROVAL_COMMENT_MAX_LENGTH,
  APPROVAL_DIFF_PROBLEMS,
  APPROVAL_STATUSES,
  approvalDetailEnvelopeSchema,
  approvalDiffSchema,
  approvalListEnvelopeSchema,
  approvalRequestSchema,
  approveApprovalRequestSchema,
  commentedDecisionRequestSchema,
  effectiveApprovalStatus,
  isApprovalExpired,
} from './approval.schema';

const NOW = new Date('2026-08-19T12:00:00.000Z');

const REQUEST = {
  id: 1,
  tenantId: 7,
  entityType: 'campaign',
  entityId: 42,
  action: 'create',
  status: 'pending',
  effectiveStatus: 'pending',
  requestedBy: 100,
  requestedByName: 'Aisha Maker',
  requestedAt: '2026-08-18T09:00:00.000Z',
  reviewedBy: null,
  reviewedByName: null,
  reviewedAt: null,
  reviewComment: null,
  expiresAt: '2026-08-25T09:00:00.000Z',
  actionable: true,
  selfSubmitted: false,
  decidable: true,
  subject: {
    campaignId: 42,
    campaignCode: 'T038_CODE',
    campaignName: 'Raya bonus',
    campaignStatus: 'pending_approval',
  },
  createdAt: '2026-08-18T09:00:00.000Z',
  updatedAt: '2026-08-18T09:00:00.000Z',
};

const DIFF = {
  renderable: true,
  problem: null,
  changed: [],
  unchangedCount: 4,
  skippedFields: [],
  budgets: [],
  warnings: [],
  trackerCount: 1,
  componentCount: 2,
};

describe('approval vocabularies', () => {
  it('transcribes ck_par_status exactly', () => {
    expect([...APPROVAL_STATUSES]).toEqual([
      'pending',
      'approved',
      'rejected',
      'expired',
      'returned',
    ]);
  });

  it('transcribes ck_par_action exactly', () => {
    expect([...APPROVAL_ACTIONS]).toEqual(['create', 'update', 'delete']);
  });

  it('states the varchar(500) comment bound once', () => {
    expect(APPROVAL_COMMENT_MAX_LENGTH).toBe(500);
  });

  it('names every reason a diff can be unrenderable', () => {
    expect([...APPROVAL_DIFF_PROBLEMS]).toEqual([
      'PAYLOAD_MISSING',
      'PAYLOAD_NOT_AN_OBJECT',
      'SUBJECT_UNAVAILABLE',
    ]);
  });
});

describe('approvalRequestSchema', () => {
  it('accepts a well-formed row', () => {
    expect(approvalRequestSchema.parse(REQUEST)).toEqual(REQUEST);
  });

  it('accepts a request whose campaign is not visible', () => {
    expect(approvalRequestSchema.parse({ ...REQUEST, subject: null }).subject).toBeNull();
  });

  it('rejects an unexpected key', () => {
    expect(() => approvalRequestSchema.parse({ ...REQUEST, extra: 1 })).toThrow();
  });

  it('rejects a missing key rather than defaulting it', () => {
    const withoutDecidable: Record<string, unknown> = { ...REQUEST };
    delete withoutDecidable['decidable'];
    expect(() => approvalRequestSchema.parse(withoutDecidable)).toThrow();
  });

  it('does not coerce a numeric id from a string', () => {
    expect(() => approvalRequestSchema.parse({ ...REQUEST, id: '1' })).toThrow();
  });

  it('rejects a status outside the five', () => {
    expect(() => approvalRequestSchema.parse({ ...REQUEST, status: 'withdrawn' })).toThrow();
  });
});

describe('envelopes', () => {
  it('wraps a list with its pagination meta', () => {
    const parsed = approvalListEnvelopeSchema.parse({
      data: [REQUEST],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
    expect(parsed.data).toHaveLength(1);
  });

  it('wraps a detail with its diff', () => {
    const parsed = approvalDetailEnvelopeSchema.parse({
      data: { request: REQUEST, diff: DIFF },
    });
    expect(parsed.data.diff.renderable).toBe(true);
  });

  it('rejects a list envelope with no meta', () => {
    expect(() => approvalListEnvelopeSchema.parse({ data: [REQUEST] })).toThrow();
  });
});

describe('approvalDiffSchema', () => {
  it('accepts an unrenderable diff carrying a problem', () => {
    const parsed = approvalDiffSchema.parse({
      ...DIFF,
      renderable: false,
      problem: 'PAYLOAD_MISSING',
      trackerCount: null,
      componentCount: null,
    });
    expect(parsed.problem).toBe('PAYLOAD_MISSING');
  });

  it('rejects a problem it does not know', () => {
    expect(() => approvalDiffSchema.parse({ ...DIFF, problem: 'SOMETHING_ELSE' })).toThrow();
  });
});

describe('the decision bodies', () => {
  it('approve accepts an empty body — the comment is optional', () => {
    expect(approveApprovalRequestSchema.parse({})).toEqual({});
  });

  it('approve rejects a comment past 500 characters', () => {
    expect(() => approveApprovalRequestSchema.parse({ comment: 'x'.repeat(501) })).toThrow();
  });

  it('approve accepts exactly 500 characters', () => {
    expect(approveApprovalRequestSchema.parse({ comment: 'x'.repeat(500) }).comment).toHaveLength(
      500,
    );
  });

  it('reject/return require a comment', () => {
    expect(() => commentedDecisionRequestSchema.parse({})).toThrow();
    expect(() => commentedDecisionRequestSchema.parse({ comment: '' })).toThrow();
  });

  it('reject/return refuse a whitespace-only comment — `.min(1)` alone would not', () => {
    expect(() => commentedDecisionRequestSchema.parse({ comment: '   ' })).toThrow();
    expect(() => commentedDecisionRequestSchema.parse({ comment: '\n\t ' })).toThrow();
  });

  it('reject/return accept a real comment and refuse an extra key', () => {
    expect(commentedDecisionRequestSchema.parse({ comment: 'Needs work.' })).toEqual({
      comment: 'Needs work.',
    });
    expect(() =>
      commentedDecisionRequestSchema.parse({ comment: 'Needs work.', reviewedBy: 1 }),
    ).toThrow();
  });
});

describe('isApprovalExpired / effectiveApprovalStatus', () => {
  it('a pending request before its deadline is not expired', () => {
    expect(
      isApprovalExpired({ status: 'pending', expiresAt: '2026-08-19T12:00:01.000Z' }, NOW),
    ).toBe(false);
  });

  it('a pending request past its deadline is expired even though the column says pending', () => {
    expect(
      isApprovalExpired({ status: 'pending', expiresAt: '2026-08-19T11:59:59.000Z' }, NOW),
    ).toBe(true);
    expect(
      effectiveApprovalStatus({ status: 'pending', expiresAt: '2026-08-19T11:59:59.000Z' }, NOW),
    ).toBe('expired');
  });

  it('treats the deadline instant itself as expired', () => {
    expect(isApprovalExpired({ status: 'pending', expiresAt: NOW.toISOString() }, NOW)).toBe(true);
  });

  it('accepts a Date as well as a string — the server reads a Date column', () => {
    expect(isApprovalExpired({ status: 'pending', expiresAt: new Date('2020-01-01') }, NOW)).toBe(
      true,
    );
  });

  it('a stored expired row is expired regardless of the date', () => {
    expect(
      isApprovalExpired({ status: 'expired', expiresAt: '2099-01-01T00:00:00.000Z' }, NOW),
    ).toBe(true);
  });

  it.each(['approved', 'rejected', 'returned'])(
    'a %s request never becomes expired, however old',
    (status) => {
      expect(isApprovalExpired({ status, expiresAt: '2020-01-01T00:00:00.000Z' }, NOW)).toBe(false);
      expect(effectiveApprovalStatus({ status, expiresAt: '2020-01-01T00:00:00.000Z' }, NOW)).toBe(
        status,
      );
    },
  );

  it('an unparseable expiry is not treated as expired — a bad value must not decide anything', () => {
    expect(isApprovalExpired({ status: 'pending', expiresAt: 'not a date' }, NOW)).toBe(false);
  });

  it('defaults `now` to the present when it is not supplied', () => {
    expect(isApprovalExpired({ status: 'pending', expiresAt: '2000-01-01T00:00:00.000Z' })).toBe(
      true,
    );
  });
});
