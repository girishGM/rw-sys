import { DEFINITION_REQUEST_REVIEW_TRANSITIONS } from '@/modules/definition-requests/definition-requests.constants';

describe('DEFINITION_REQUEST_REVIEW_TRANSITIONS — 06-VERSIONING.md §9 state diagram', () => {
  it('submitted → under_review only', () => {
    expect(DEFINITION_REQUEST_REVIEW_TRANSITIONS.submitted).toEqual(['under_review']);
  });

  it('under_review → approved or rejected', () => {
    expect([...DEFINITION_REQUEST_REVIEW_TRANSITIONS.under_review].sort()).toEqual([
      'approved',
      'rejected',
    ]);
  });

  it('approved/rejected/fulfilled/withdrawn accept no further .../review transition', () => {
    for (const status of ['approved', 'rejected', 'fulfilled', 'withdrawn'] as const) {
      expect(DEFINITION_REQUEST_REVIEW_TRANSITIONS[status]).toEqual([]);
    }
  });
});
