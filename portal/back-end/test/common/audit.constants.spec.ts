/**
 * T-014 — the drift guard.
 *
 * `audit.constants.ts` duplicates four response codes as string literals rather than importing
 * them from `common/rbac`, `common/security` and `modules/auth` (see that file's header: a leaf
 * that the error filter and every Wave 3 module depend on must not transitively import three
 * feature modules). Duplication is only acceptable if it cannot silently drift, so this suite is
 * the mechanism that makes it not silent: rename `PERM_DENIED` anywhere and this fails.
 *
 * It also pins the two `campaign_audit_trail` unions to the live `CHECK` constraints, which the
 * e2e suite verifies against the real database.
 */
import {
  CAMPAIGN_AUDIT_ACTION,
  CAMPAIGN_AUDIT_ENTITY_TYPE,
  FAILURE_EVENT_BY_CODE,
  PORTAL_AUDIT_EVENT,
  AUDIT_EVENT_COLUMN_LIMIT,
  AUDIT_TARGET_COLUMN_LIMIT,
} from '@/common/audit/audit.constants';
import { PERMISSION_DENIED_CODE } from '@/common/rbac/rbac.constants';
import { SECURITY_ERROR_CODE } from '@/common/security/security.constants';
import { AUTH_ERROR_CODE } from '@/modules/auth/session.constants';
import { AUTH_AUDIT_EVENT } from '@/modules/auth/session.constants';

describe('audit constants', () => {
  describe('the duplicated response codes still match their source of truth', () => {
    it.each([
      ['PERM_DENIED', PERMISSION_DENIED_CODE],
      ['AUTH_INVALID_CREDENTIALS', AUTH_ERROR_CODE.INVALID_CREDENTIALS],
      ['CSRF_TOKEN_MISSING', SECURITY_ERROR_CODE.CSRF_TOKEN_MISSING],
      ['CSRF_TOKEN_INVALID', SECURITY_ERROR_CODE.CSRF_TOKEN_INVALID],
    ])('%s is a key of FAILURE_EVENT_BY_CODE', (literal, source) => {
      expect(literal).toBe(source);
      expect(FAILURE_EVENT_BY_CODE[source]).toBeDefined();
    });
  });

  describe('the two stores stay separate (01-DATABASE.md §2.5)', () => {
    it('shares no event name with T-011’s authentication events', () => {
      // T-011 writes the success side (`login_succeeded`); this task writes the failure side.
      // An overlap would mean two components writing the same event type with different shapes.
      const authEvents: string[] = Object.values(AUTH_AUDIT_EVENT);
      const overlap = Object.values(PORTAL_AUDIT_EVENT).filter((event) =>
        authEvents.includes(event),
      );
      expect(overlap).toEqual([]);
    });

    it('keeps every portal event within the varchar(60) column', () => {
      for (const event of Object.values(PORTAL_AUDIT_EVENT)) {
        expect(event.length).toBeLessThanOrEqual(AUDIT_EVENT_COLUMN_LIMIT);
        expect(event).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    });

    it('pins the column limits the service truncates to', () => {
      expect(AUDIT_EVENT_COLUMN_LIMIT).toBe(60);
      expect(AUDIT_TARGET_COLUMN_LIMIT).toBe(60);
    });
  });

  describe('the campaign_audit_trail unions match ck_cat_action / ck_cat_entity_type', () => {
    it('lists exactly the nine permitted actions', () => {
      expect(Object.values(CAMPAIGN_AUDIT_ACTION).sort()).toEqual(
        [
          'approved',
          'assigned',
          'created',
          'deleted',
          'rejected',
          'status_changed',
          'submitted',
          'unassigned',
          'updated',
        ].sort(),
      );
    });

    it('lists exactly the nine permitted entity types', () => {
      expect(Object.values(CAMPAIGN_AUDIT_ENTITY_TYPE).sort()).toEqual(
        [
          'campaign',
          'campaign_approval',
          'campaign_submit',
          'cap_override',
          'entity_assignment',
          'reward_assignment',
          'rule_assignment',
          'tracker',
          'tracker_component',
        ].sort(),
      );
    });
  });
});
