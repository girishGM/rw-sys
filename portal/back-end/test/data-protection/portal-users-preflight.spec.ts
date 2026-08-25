/**
 * T-070 — unit cover for the `t056-backfill` preflight (`support/portal-users-preflight.ts`).
 *
 * This is the regression test the task file calls TC-3, and it is a unit test rather than an e2e
 * one on purpose. The bug being fixed is a guard that refused a *safe* input, and the guard's
 * remaining job is to refuse a genuinely *unsafe* one — a row encrypted under a key nobody can
 * reach any more. Neither branch can be exercised honestly from inside the e2e suite: creating
 * the unsafe input there means writing an undecryptable row into the shared development database,
 * which is precisely the residue class T-067 exists to clean up. Here both branches are ordinary
 * function calls over a stub.
 *
 * The two assertions that matter, stated as the properties rather than as the code:
 *
 *  - a foreign row whose key material **is** reachable does not block the suite (the defect: it
 *    used to, because the old guard counted rows instead of checking them); and
 *  - a foreign row whose key material is **not** reachable still does, naming the row and the kid.
 */
import {
  classifyForeignRow,
  describeBlockedRows,
  isBlocking,
  preflightForeignRows,
  type EmailCryptoLike,
  type ForeignRow,
} from './support/portal-users-preflight';
import { UNDECRYPTABLE_SENTINEL } from '@/common/data-protection/data-protection.constants';
import { formatCiphertext } from '@/common/crypto';

/** A syntactically valid `v1.<kid>.<iv>.<tag>.<ct>` envelope. Never decrypted — only classified. */
function envelope(kid: string): string {
  return formatCiphertext(kid, Buffer.alloc(12, 1), Buffer.alloc(16, 2), Buffer.from('body'));
}

/**
 * A stand-in for `PortalUserEmailCrypto` in which decryptability is decided by kid.
 *
 * `blindIndexFor` is a visible, deterministic transform rather than a real HMAC so a test can
 * assert *which* address a fingerprint came from — the property the e2e suite relies on when it
 * checks that a foreign row's address survived the round trip unchanged.
 */
function stubCrypto(readable: Record<string, string>): EmailCryptoLike {
  return {
    decryptForRow(_userId: number, stored: string): string {
      const kid = stored.split('.')[1];
      return readable[kid] ?? UNDECRYPTABLE_SENTINEL;
    },
    blindIndexFor(email: string): string {
      return `bidx(${email})`;
    },
  };
}

describe('portal-users preflight', () => {
  const READABLE_KID = 'dev_local_fld';
  const LOST_KID = 't031_t056_fld';

  describe('classifyForeignRow', () => {
    it('accepts a row whose key material is reachable, and fingerprints its address', () => {
      const row: ForeignRow = { id: 3235, email: envelope(READABLE_KID) };
      const check = classifyForeignRow(
        row,
        stubCrypto({ [READABLE_KID]: 'reviewer@example.test' }),
      );

      expect(check).toEqual({
        id: 3235,
        verdict: 'decryptable',
        kid: READABLE_KID,
        fingerprint: 'bidx(reviewer@example.test)',
      });
      expect(isBlocking(check)).toBe(false);
    });

    it('accepts a plaintext row — a row written before T056_001 ran is legitimate', () => {
      const check = classifyForeignRow({ id: 7, email: 'legacy@example.test' }, stubCrypto({}));

      expect(check).toEqual({
        id: 7,
        verdict: 'plaintext',
        kid: null,
        fingerprint: 'bidx(legacy@example.test)',
      });
      expect(isBlocking(check)).toBe(false);
    });

    it('blocks a row whose key material is gone, and names the kid it needs', () => {
      const check = classifyForeignRow({ id: 42, email: envelope(LOST_KID) }, stubCrypto({}));

      expect(check).toEqual({ id: 42, verdict: 'unreadable', kid: LOST_KID, fingerprint: null });
      expect(isBlocking(check)).toBe(true);
    });

    it('blocks a value that starts like an envelope but does not parse as one', () => {
      // `looksLikeCiphertext` is only a `v1.` prefix test, so this reaches `parseCiphertext`.
      const check = classifyForeignRow({ id: 43, email: 'v1.not-an-envelope' }, stubCrypto({}));

      expect(check).toEqual({ id: 43, verdict: 'unreadable', kid: null, fingerprint: null });
    });

    it('blocks a row whose decryption throws rather than returning the sentinel', () => {
      const throwing: EmailCryptoLike = {
        decryptForRow(): string {
          throw new Error('key registry unavailable');
        },
        blindIndexFor: (email) => `bidx(${email})`,
      };

      expect(classifyForeignRow({ id: 44, email: envelope(READABLE_KID) }, throwing)).toEqual({
        id: 44,
        verdict: 'unreadable',
        kid: READABLE_KID,
        fingerprint: null,
      });
    });
  });

  describe('preflightForeignRows', () => {
    /**
     * The defect itself, expressed as a property. These are the three rows actually present in the
     * development database on 2026-08-21 — all decryptable, all rejected by the old
     * `expect(foreign).toBe(0)` guard purely for existing.
     */
    it('lets a table full of decryptable foreign rows through', () => {
      const rows: ForeignRow[] = [
        { id: 3235, email: envelope(READABLE_KID) },
        { id: 3344, email: envelope(READABLE_KID) },
        { id: 4657, email: envelope(READABLE_KID) },
      ];

      const checks = preflightForeignRows(rows, stubCrypto({ [READABLE_KID]: 'a@example.test' }));

      expect(checks.map((c) => c.verdict)).toEqual(['decryptable', 'decryptable', 'decryptable']);
      expect(checks.map((c) => c.id)).toEqual([3235, 3344, 4657]);
    });

    it('throws when even one row among many is unreadable', () => {
      const rows: ForeignRow[] = [
        { id: 3235, email: envelope(READABLE_KID) },
        { id: 9001, email: envelope(LOST_KID) },
      ];

      expect(() =>
        preflightForeignRows(rows, stubCrypto({ [READABLE_KID]: 'a@example.test' })),
      ).toThrow(/portal_users\.id=9001 \(kid=t031_t056_fld\)/);
    });

    it('returns an empty list for an empty table rather than throwing', () => {
      expect(preflightForeignRows([], stubCrypto({}))).toEqual([]);
    });
  });

  describe('describeBlockedRows', () => {
    const blocked = [
      { id: 9001, verdict: 'unreadable' as const, kid: LOST_KID, fingerprint: null },
      { id: 9002, verdict: 'unreadable' as const, kid: null, fingerprint: null },
    ];

    it('names every blocked row, its kid, and what to do about it', () => {
      const message = describeBlockedRows(blocked);

      expect(message).toContain('2 row(s)');
      expect(message).toContain(`portal_users.id=9001 (kid=${LOST_KID})`);
      expect(message).toContain('portal_users.id=9002 (kid=unparseable)');
      expect(message).toContain('Restore the encryption key');
    });

    it('never puts an address in the message', () => {
      // The whole point of carrying a blind index rather than the plaintext: a preflight failure
      // is printed to a terminal and captured in CI logs, and must not carry anyone's email.
      const withAddress = [
        { id: 9003, verdict: 'unreadable' as const, kid: LOST_KID, fingerprint: null },
      ];
      expect(describeBlockedRows(withAddress)).not.toMatch(/@/);
    });
  });
});
