/**
 * T-037 implementation note 2 / gap G5 — the `ActorRef` helper.
 *
 * *"Improvising per call site makes the audit trail unjoinable."* These tests pin the one
 * property that matters: the `varchar` form and the `int` form describe the **same** actor and
 * can be joined back to each other.
 */
import {
  actorRefId,
  actorRefText,
  actorRefs,
  parseActorRefText,
} from '@/modules/campaigns/actor-ref';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';

const actor = { userId: 42 } as AuthenticatedUser;

describe('T-037 ActorRef', () => {
  it('renders a varchar column reference as plain decimal', () => {
    expect(actorRefText(actor)).toBe('42');
  });

  it('renders an int column reference as a number', () => {
    expect(actorRefId(actor)).toBe(42);
  });

  it('keeps the two forms joinable, which is the whole point of gap G5', () => {
    expect(parseActorRefText(actorRefText(actor))).toBe(actorRefId(actor));
  });

  it('offers both forms of one actor together', () => {
    expect(actorRefs(actor)).toEqual({ text: '42', id: 42 });
  });

  describe('parseActorRefText', () => {
    it('reads back what this helper wrote', () => {
      expect(parseActorRefText('7')).toBe(7);
    });

    it('returns null for a value this helper did not write', () => {
      // Legacy `tenant_campaigns.created_by` rows come from the `create-campaign` agents, which
      // predate the portal and put free text in this column.
      for (const value of ['agent-v2', '', 'user-7', '7.0', '-7', '1234567890']) {
        expect(parseActorRefText(value)).toBeNull();
      }
    });

    it('returns null for a null column', () => {
      expect(parseActorRefText(null)).toBeNull();
    });
  });
});
