/**
 * T-010 — `PasswordPolicyService`. TC-6…TC-12 live here.
 *
 * The task file's cases are the floor, not the target (AGENT-PROTOCOL §3). The additions
 * below are the ones that would actually catch a regression: that each rule fires
 * *independently* of the others (a test asserting only "rejected" passes even if the wrong
 * rule fired), that the common-password list survives the decorations people really use, and
 * that the reuse check is a real Argon2 comparison rather than a string equality that would
 * silently pass every salted hash.
 */
import * as argon2 from 'argon2';
import { ARGON2_OPTIONS, PASSWORD_MAX_LENGTH } from '@/modules/auth/auth.constants';
import { PasswordPolicyService } from '@/modules/auth/services/password-policy.service';

describe('PasswordPolicyService', () => {
  const policy = new PasswordPolicyService();

  describe('synchronous rules', () => {
    it('rejects a password shorter than 12 characters (TC-6)', () => {
      expect(policy.validateSync('Short1!')).toContain('too_short');
    });

    it('rejects a long password drawn from a single character class (TC-7)', () => {
      const violations = policy.validateSync('alllowercaseletters');
      expect(violations).toContain('insufficient_character_classes');
      // Length is fine — this must fail for the class rule alone, not incidentally.
      expect(violations).not.toContain('too_short');
    });

    it('rejects a common password even when decorated to satisfy every other rule (TC-8)', () => {
      const violations = policy.validateSync('Password123!');
      expect(violations).toContain('common_password');
      // 12 chars, four classes: every other rule passes, so the list is doing the work.
      expect(violations).toEqual(['common_password']);
    });

    it('rejects a password containing the email address (TC-9)', () => {
      const violations = policy.validateSync('gm@x.comAAA1!', { email: 'gm@x.com' });
      expect(violations).toContain('contains_email');
      expect(violations).toEqual(['contains_email']);
    });

    it('accepts a strong passphrase (TC-10)', () => {
      expect(policy.validateSync('Tr0ub4dor&3xample')).toEqual([]);
    });

    it('accepts the TC-10 passphrase even when an email is in play', () => {
      expect(policy.validateSync('Tr0ub4dor&3xample', { email: 'someone@example.com' })).toEqual(
        [],
      );
    });
  });

  describe('character classes', () => {
    // Three of four is the bar, so each of these must pass with exactly three classes and
    // fail when one is removed.
    it.each([
      ['lower+upper+digit', 'AbcdefghijK1'],
      ['lower+upper+symbol', 'Abcdefghij-K'],
      ['lower+digit+symbol', 'abcdefghij1-'],
      ['upper+digit+symbol', 'ABCDEFGHIJ1-'],
    ])('accepts %s (three classes)', (_label, password) => {
      expect(policy.validateSync(password)).not.toContain('insufficient_character_classes');
    });

    it.each([
      ['lower only', 'abcdefghijklm'],
      ['upper only', 'ABCDEFGHIJKLM'],
      ['digit only', '4830295718362'],
      ['symbol only', '-_-_-_-_-_-_-'],
      ['two classes', 'abcdefghijK'],
    ])('rejects %s (fewer than three classes)', (_label, password) => {
      expect(policy.validateSync(password)).toContain('insufficient_character_classes');
    });

    it('counts non-ASCII letters as letters rather than as symbols', () => {
      // A Greek passphrase has lower+upper+digit and must not be misread as "symbols only".
      expect(policy.validateSync('Καλημέρα κόσμε1')).not.toContain(
        'insufficient_character_classes',
      );
    });
  });

  describe('common-password list', () => {
    it.each([
      ['bare', 'password'],
      ['leet-substituted', 'p@ssw0rd'],
      ['digit-suffixed', 'password123'],
      ['symbol-wrapped', '!!letmein!!'],
      ['leet then wrapped', '#l3tm31n#'],
      ['mixed case', 'PaSsWoRd'],
      ['administrative', 'sup3radmin'],
    ])('rejects a %s common password', (_label, password) => {
      expect(policy.validateSync(password)).toContain('common_password');
    });

    it.each([
      ['Tr0ub4dor&3xample'],
      ['Correct-Horse-Battery-9'],
      ['Quartz#Lantern42'],
      ['mUlberry.Ridge.88'],
    ])('does not flag %s as a common password', (password) => {
      expect(policy.validateSync(password)).not.toContain('common_password');
    });
  });

  describe('email containment', () => {
    it('rejects a password containing the local part when it is long enough to matter', () => {
      expect(policy.validateSync('finance-Team1!', { email: 'finance@example.com' })).toContain(
        'contains_email',
      );
    });

    it('ignores a short local part appearing incidentally', () => {
      // 'gm' is below PASSWORD_EMAIL_LOCAL_PART_MIN_LENGTH; 'Augment' legitimately contains
      // it, and rejecting this would train users towards weaker choices.
      expect(policy.validateSync('AugmentQuartz-9', { email: 'gm@x.com' })).toEqual([]);
    });

    it('matches case-insensitively', () => {
      expect(policy.validateSync('FINANCE-Team1!', { email: 'Finance@Example.com' })).toContain(
        'contains_email',
      );
    });

    it('ignores the rule entirely when no email is supplied', () => {
      expect(policy.validateSync('AugmentQuartz-9')).toEqual([]);
      expect(policy.validateSync('AugmentQuartz-9', { email: null })).toEqual([]);
    });
  });

  describe('length bounds', () => {
    it('accepts a password at exactly the minimum length', () => {
      expect(policy.validateSync('Abcdefghij1-')).toEqual([]);
    });

    it('accepts a password at exactly the maximum length', () => {
      const atLimit = `Aa1-${'x'.repeat(PASSWORD_MAX_LENGTH - 4)}`;
      expect(atLimit).toHaveLength(PASSWORD_MAX_LENGTH);
      expect(policy.validateSync(atLimit)).toEqual([]);
    });

    it('rejects a password one character over the maximum (unbounded pre-auth work)', () => {
      const overLimit = `Aa1-${'x'.repeat(PASSWORD_MAX_LENGTH - 3)}`;
      expect(overLimit).toHaveLength(PASSWORD_MAX_LENGTH + 1);
      expect(policy.validateSync(overLimit)).toContain('too_long');
    });

    it('reports every broken rule at once, not just the first', () => {
      // Short, single-class, common, and contains the email — all four at once.
      const violations = policy.validateSync('admin', { email: 'admin@example.com' });
      expect(violations).toEqual(
        expect.arrayContaining([
          'too_short',
          'insufficient_character_classes',
          'common_password',
          'contains_email',
        ]),
      );
    });
  });

  describe('history / reuse (Argon2, not string equality)', () => {
    // Real hashes, produced with the production options — the point of these cases is that a
    // salted hash of the same password is a *different string*.
    let currentHash: string;
    let previousHashes: string[];

    beforeAll(async () => {
      currentHash = await argon2.hash('Curr3nt-Quartz-1', ARGON2_OPTIONS);
      previousHashes = await Promise.all(
        [
          'Hist0ry-Alpha-1',
          'Hist0ry-Bravo-2',
          'Hist0ry-Charlie3',
          'Hist0ry-Delta-4',
          'Hist0ry-Echo-5',
        ].map((password) => argon2.hash(password, ARGON2_OPTIONS)),
      );
    }, 60_000);

    it('rejects a password matching one of the last 5 hashes (TC-11)', async () => {
      const violations = await policy.validate('Hist0ry-Charlie3', { currentHash, previousHashes });
      expect(violations).toContain('password_reused');
    });

    it('rejects each of the five stored hashes individually (TC-11, exhaustive)', async () => {
      for (const password of [
        'Hist0ry-Alpha-1',
        'Hist0ry-Bravo-2',
        'Hist0ry-Charlie3',
        'Hist0ry-Delta-4',
        'Hist0ry-Echo-5',
      ]) {
        expect(await policy.isReused(password, { currentHash, previousHashes })).toBe(true);
      }
    }, 60_000);

    it('rejects the password currently in use', async () => {
      expect(await policy.isReused('Curr3nt-Quartz-1', { currentHash, previousHashes })).toBe(true);
    });

    it('accepts a password older than the 5-entry window (TC-12)', async () => {
      // The 6th-oldest hash has already been trimmed out of `previous_hashes`, so it is
      // available again — that is exactly what "the last 5" means.
      const violations = await policy.validate('Hist0ry-Ancient6', { currentHash, previousHashes });
      expect(violations).toEqual([]);
    });

    it('treats an absent history as nothing to compare against', async () => {
      expect(await policy.isReused('AugmentQuartz-9', {})).toBe(false);
      expect(await policy.isReused('AugmentQuartz-9', { previousHashes: null })).toBe(false);
      expect(await policy.isReused('AugmentQuartz-9', { currentHash: null })).toBe(false);
    });

    it('defaults the context when called with none at all', async () => {
      // Both async entry points default `context` to `{}`; a caller that omits it must get a
      // clean "no history to check" rather than a TypeError on `context.previousHashes`.
      expect(await policy.isReused('AugmentQuartz-9')).toBe(false);
      expect(await policy.validate('AugmentQuartz-9')).toEqual([]);
    });

    it('skips unusable history entries instead of throwing or matching them', async () => {
      // A corrupt column must not be able to block a password change, and "unreadable" is
      // not "matched".
      const violations = await policy.validate('AugmentQuartz-9', {
        currentHash: 'not-an-argon2-digest',
        previousHashes: ['', '$argon2id$broken'],
      });
      expect(violations).toEqual([]);
    });

    it('still reports the synchronous violations alongside a reuse hit', async () => {
      const violations = await policy.validate('Hist0ry-Echo-5', {
        email: 'hist0ry-echo-5@example.com',
        currentHash,
        previousHashes,
      });
      expect(violations).toEqual(expect.arrayContaining(['contains_email', 'password_reused']));
    });
  });
});
