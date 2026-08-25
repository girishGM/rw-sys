/**
 * T-067 — the orphaned-test-key sweep (`test/support/encryption-keys.ts`).
 *
 * The property under test is a *safety* property as much as a cleanup one: the sweep must remove
 * every row an interrupted run could have left, and must not remove anything else — least of all
 * a row a real deployment created. Both halves are asserted here, because a sweep that is merely
 * effective is a sweep that eventually deletes a production key.
 *
 * Lives in `test/crypto/` rather than beside the module it covers because `jest.config.js`'s
 * `roots` list is owned by another task and is append-only for this one; `test/crypto` is already
 * a root and is this task's own territory.
 */
import type { Sequelize } from 'sequelize-typescript';
import {
  generateKeyMaterial,
  isKeyRefResolvable,
  isTestOwnedKid,
  LEGACY_TEST_KID_PATTERNS,
  sweepOrphanedTestKeys,
  TEST_KID_PREFIX,
} from '../support/encryption-keys';

interface Row {
  kid: string;
  key_ref: string;
}

/**
 * The narrowest possible stand-in for `Sequelize`: it answers the one SELECT the sweep issues
 * and applies the one DELETE. Deliberately not `test/crypto/support/fake-db.ts`, whose `query()`
 * routes on `includes('FROM reward_portal.encryption_keys')` and would therefore mistake this
 * module's `DELETE … FROM reward_portal.encryption_keys` for a SELECT.
 */
class KeyTableDouble {
  readonly deletes: string[][] = [];

  constructor(public rows: Row[]) {}

  asSequelize(): Sequelize {
    return this as unknown as Sequelize;
  }

  async query<T>(
    sql: string,
    options: { replacements?: Record<string, unknown> } = {},
  ): Promise<T[]> {
    if (sql.trimStart().startsWith('SELECT')) return this.rows.map((r) => ({ ...r })) as T[];

    if (sql.trimStart().startsWith('DELETE')) {
      const kids = options.replacements?.kids as string[];
      this.deletes.push([...kids]);
      this.rows = this.rows.filter((r) => !kids.includes(r.kid));
      return [] as T[];
    }
    throw new Error(`KeyTableDouble does not model: ${sql}`);
  }
}

/** Silences (and captures) the sweep's deliberate `console.warn`. */
function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  return { lines, restore: (): void => void (console.warn = original) };
}

describe('T-067 — orphaned test encryption keys', () => {
  describe('isTestOwnedKid', () => {
    it('claims the reserved prefix', () => {
      expect(isTestOwnedKid(`${TEST_KID_PREFIX}anything_at_all`)).toBe(true);
    });

    it.each([
      ['portal-user-fixture field', 't031_t056_fld'],
      ['portal-user-fixture blind index', 't033ui_t056_bidx'],
      ['super-admin-mfa', 'me_mfa_fld'],
      ['crypto e2e', 't016_e2e_fld_1'],
      ['data-protection e2e', 't017_e2e_bidx'],
      ['transport-crypto e2e', 't018_e2e_fld'],
      ['mfa e2e', 't055_e2e_bidx'],
      ['t056 backfill', 't056_backfill_fld'],
    ])('claims the legacy %s namespace (%s)', (_label, kid) => {
      expect(isTestOwnedKid(kid)).toBe(true);
    });

    /**
     * The important half. Every kid here is one a real deployment plausibly holds — including
     * the two this development machine actually has, and the shape
     * `src/database/cli/encryption-keys.ts` generates by default (`<purpose>_<YYYYMMDD>`).
     */
    it.each([
      ['this machine’s real local field key', 'dev_local_fld'],
      ['this machine’s real local blind key', 'dev_local_bidx'],
      ['the CLI default shape', 'field_20260821'],
      ['the CLI default shape, blind index', 'blind_index_20260821'],
      ['a hand-named production key', 'fld_2026_01'],
      ['a transport key', 'transport_2026_01'],
      ['near-miss: t056 without the suffix', 'acme_t056_something'],
      ['near-miss: mfa but not the fixture shape', 'prod_mfa_field'],
      ['near-miss: prefix in the middle', 'x_t016_e2e_fld'],
    ])('does NOT claim %s (%s)', (_label, kid) => {
      expect(isTestOwnedKid(kid)).toBe(false);
    });

    it('every legacy pattern is anchored, so none can match mid-string', () => {
      for (const pattern of LEGACY_TEST_KID_PATTERNS) {
        expect(pattern.source.startsWith('^')).toBe(true);
      }
    });
  });

  describe('isKeyRefResolvable', () => {
    it('is true when the variable holds material', () => {
      expect(isKeyRefResolvable('env:PRESENT', { PRESENT: 'abc' })).toBe(true);
    });

    it('is false when the variable is absent', () => {
      expect(isKeyRefResolvable('env:ABSENT', {})).toBe(false);
    });

    it('is false when the variable is present but empty', () => {
      expect(isKeyRefResolvable('env:EMPTY', { EMPTY: '' })).toBe(false);
    });

    it('never judges a kms ref, so a kms row is never swept', () => {
      expect(isKeyRefResolvable('kms:arn:aws:kms:eu-west-1:1:key/x', {})).toBe(true);
    });

    it('never judges a ref with no scheme', () => {
      expect(isKeyRefResolvable('PLAIN_NAME', {})).toBe(true);
    });
  });

  describe('sweepOrphanedTestKeys', () => {
    it('removes a test row whose material this process cannot reach', async () => {
      const db = new KeyTableDouble([{ kid: 't031_t056_fld', key_ref: 'env:T031_T056_FIELD_KEY' }]);
      const warn = captureWarnings();

      const removed = await sweepOrphanedTestKeys(db.asSequelize(), {});
      warn.restore();

      expect(removed).toEqual(['t031_t056_fld']);
      expect(db.rows).toEqual([]);
      expect(warn.lines.join('\n')).toContain('t031_t056_fld');
    });

    it('keeps a test row whose material IS reachable — a live suite must not be sabotaged', async () => {
      const db = new KeyTableDouble([{ kid: 't031_t056_fld', key_ref: 'env:LIVE' }]);

      const removed = await sweepOrphanedTestKeys(db.asSequelize(), {
        LIVE: generateKeyMaterial(),
      });

      expect(removed).toEqual([]);
      expect(db.rows).toHaveLength(1);
      expect(db.deletes).toEqual([]);
    });

    /**
     * The one that matters most. An unresolvable row that is *not* test-owned is left strictly
     * alone: it will fail the boot, loudly, which is exactly what a real missing production key
     * should do. The sweep is not a general-purpose "make boot work" button.
     */
    it('never removes an unresolvable row outside the test namespace', async () => {
      const db = new KeyTableDouble([
        { kid: 'dev_local_fld', key_ref: 'env:DEV_LOCAL_FIELD_KEY' },
        { kid: 'field_20260101', key_ref: 'env:FIELD_KEY_2026_01' },
      ]);

      const removed = await sweepOrphanedTestKeys(db.asSequelize(), {});

      expect(removed).toEqual([]);
      expect(db.rows).toHaveLength(2);
      expect(db.deletes).toEqual([]);
    });

    it('sweeps only the orphans out of a mixed table, in one DELETE', async () => {
      const db = new KeyTableDouble([
        { kid: 'dev_local_fld', key_ref: 'env:DEV_LOCAL_FIELD_KEY' }, // real, unresolvable → keep
        { kid: 't031_t056_fld', key_ref: 'env:GONE_1' }, //               orphan → sweep
        { kid: 't033_t056_bidx', key_ref: 'env:GONE_2' }, //              orphan → sweep
        { kid: 't045ui_t056_fld', key_ref: 'env:HERE' }, //               test but live → keep
      ]);
      const warn = captureWarnings();

      const removed = await sweepOrphanedTestKeys(db.asSequelize(), { HERE: 'x' });
      warn.restore();

      expect(removed).toEqual(['t031_t056_fld', 't033_t056_bidx']);
      expect(db.rows.map((r) => r.kid)).toEqual(['dev_local_fld', 't045ui_t056_fld']);
      expect(db.deletes).toHaveLength(1);
    });

    it('is a silent no-op on a clean table', async () => {
      const db = new KeyTableDouble([{ kid: 'dev_local_fld', key_ref: 'env:PRESENT' }]);
      const warn = captureWarnings();

      const removed = await sweepOrphanedTestKeys(db.asSequelize(), { PRESENT: 'x' });
      warn.restore();

      expect(removed).toEqual([]);
      expect(warn.lines).toEqual([]);
    });

    it('is idempotent — a second sweep finds nothing left to do', async () => {
      const db = new KeyTableDouble([{ kid: 't031_t056_fld', key_ref: 'env:GONE' }]);
      const warn = captureWarnings();

      expect(await sweepOrphanedTestKeys(db.asSequelize(), {})).toHaveLength(1);
      expect(await sweepOrphanedTestKeys(db.asSequelize(), {})).toEqual([]);
      warn.restore();

      expect(db.deletes).toHaveLength(1);
    });

    it('defaults to the real process environment', async () => {
      process.env.T067_SPEC_PRESENT = 'x';
      const db = new KeyTableDouble([{ kid: 't016_e2e_a', key_ref: 'env:T067_SPEC_PRESENT' }]);
      try {
        expect(await sweepOrphanedTestKeys(db.asSequelize())).toEqual([]);
      } finally {
        delete process.env.T067_SPEC_PRESENT;
      }
    });
  });

  describe('generateKeyMaterial', () => {
    it('produces 32 distinct random bytes as base64', () => {
      const a = generateKeyMaterial();
      const b = generateKeyMaterial();
      expect(Buffer.from(a, 'base64')).toHaveLength(32);
      expect(a).not.toEqual(b);
    });
  });
});
