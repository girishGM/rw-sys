/**
 * T-037 implementation note 3 — the state machine, exhaustively.
 *
 * The table is small enough to assert **every** (status, transition) pair rather than a sample,
 * which is the whole reason it was written as a table: a transition nobody thought about is
 * exactly the one that would otherwise be legal by accident.
 */
import {
  assertTransition,
  availableTransitions,
  effectiveStatus,
  isEditable,
  nextStatus,
  type CampaignTransition,
} from '@/modules/campaigns/campaign-state-machine';
import { CampaignTransitionNotAllowedError } from '@/modules/campaigns/campaigns.errors';

const STATUSES = [
  'draft',
  'pending_approval',
  'active',
  'paused',
  'completed',
  'archived',
] as const;

const TRANSITIONS: readonly CampaignTransition[] = [
  'submit',
  'approve',
  'reject',
  'return',
  'pause',
  'resume',
  'complete',
  'archive',
];

/** The complete legal set, transcribed from 03-API-CONTRACT.md §11's diagram — not from the
 * implementation, so a change to the table has to be justified against the design here. */
const LEGAL: Readonly<Record<string, Partial<Record<CampaignTransition, string>>>> = {
  draft: { submit: 'pending_approval' },
  pending_approval: { approve: 'active', reject: 'draft', return: 'draft' },
  active: { pause: 'paused', complete: 'completed' },
  paused: { resume: 'active', complete: 'completed' },
  completed: { archive: 'archived' },
  archived: {},
};

describe('T-037 campaign state machine', () => {
  it('permits exactly the transitions the API contract draws, and no others', () => {
    for (const status of STATUSES) {
      for (const transition of TRANSITIONS) {
        expect(nextStatus(status, transition)).toBe(LEGAL[status][transition] ?? null);
      }
    }
  });

  it('archived is terminal', () => {
    expect(availableTransitions('archived')).toEqual([]);
  });

  it('lists the available transitions per status, for a UI that renders actions from data', () => {
    expect([...availableTransitions('pending_approval')].sort()).toEqual([
      'approve',
      'reject',
      'return',
    ]);
  });

  it('treats an unknown status as having no transitions rather than throwing', () => {
    // A status this code has never heard of can only come from a row written by something other
    // than the portal. Refusing every transition is the fail-closed answer.
    expect(nextStatus('nonsense', 'submit')).toBeNull();
    expect(availableTransitions('nonsense')).toEqual([]);
  });

  describe('assertTransition', () => {
    it('returns the next status for a legal transition', () => {
      expect(assertTransition('draft', 'submit')).toBe('pending_approval');
    });

    it('throws a 409 for an illegal one', () => {
      expect(() => assertTransition('active', 'submit')).toThrow(CampaignTransitionNotAllowedError);
      try {
        assertTransition('active', 'submit');
      } catch (error) {
        expect((error as CampaignTransitionNotAllowedError).status).toBe(409);
      }
    });

    it('refuses to re-submit a campaign already awaiting approval', () => {
      // The concurrency guard that stops two submits both creating an approval request.
      expect(() => assertTransition('pending_approval', 'submit')).toThrow(
        CampaignTransitionNotAllowedError,
      );
    });
  });

  describe('isEditable', () => {
    it('permits editing a draft only', () => {
      expect(isEditable('draft')).toBe(true);
      for (const status of ['pending_approval', 'active', 'paused', 'completed', 'archived']) {
        expect(isEditable(status)).toBe(false);
      }
    });
  });

  describe('effectiveStatus — the derived "returned" state', () => {
    it('presents a draft whose last decision was a return as returned', () => {
      expect(effectiveStatus('draft', 'returned')).toBe('returned');
    });

    it('leaves a never-submitted draft as a draft', () => {
      expect(effectiveStatus('draft', null)).toBe('draft');
    });

    it('leaves a rejected campaign as a draft — reject and return differ in the request, not the campaign', () => {
      expect(effectiveStatus('draft', 'rejected')).toBe('draft');
    });

    it('never overrides a non-draft status', () => {
      expect(effectiveStatus('active', 'returned')).toBe('active');
      expect(effectiveStatus('pending_approval', 'pending')).toBe('pending_approval');
    });
  });
});
