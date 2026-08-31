/**
 * T-010 — `CredentialRepository`, the credential layer's only door to the database.
 *
 * Driven against a stubbed `Sequelize` that records what it was asked to run. That is
 * deliberately a *statement-shape* test, not a SQL-correctness test: it pins the things that
 * are security properties rather than query semantics —
 *
 *  - every attacker-controlled value arrives as a **bound replacement**, never concatenated;
 *  - the lookup filters `deleted_at IS NULL`, so a soft-deleted account cannot authenticate;
 *  - the lookup is a single statement, so the known and unknown paths do equal database work;
 *  - oversized `email`/`user_agent` are truncated before they can raise a column-width error
 *    that would make one request answer differently from another;
 *  - a malformed `ip_address` degrades to NULL instead of failing the INSERT that records the
 *    attempt.
 *
 * Whether the SQL itself returns the right rows is proven against the real Postgres instance
 * by T-011's `auth.e2e-spec.ts`, not here.
 */
import type { Sequelize } from 'sequelize-typescript';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import {
  CredentialRepository,
  type AuthTransaction,
} from '@/modules/auth/services/credential.repository';
import { buildEmailCrypto } from './support/email-crypto';
import {
  LOGIN_ATTEMPT_EMAIL_MAX_LENGTH,
  LOGIN_ATTEMPT_USER_AGENT_MAX_LENGTH,
} from '@/modules/auth/auth.constants';

interface RecordedQuery {
  sql: string;
  options: { replacements?: Record<string, unknown>; transaction?: AuthTransaction };
}

class StubSequelize {
  readonly calls: RecordedQuery[] = [];
  responses: unknown[][] = [];

  async query(sql: string, options: RecordedQuery['options']): Promise<unknown[]> {
    this.calls.push({ sql, options });
    return this.responses.shift() ?? [];
  }

  async transaction<T>(fn: (tx: AuthTransaction) => Promise<T>): Promise<T> {
    return fn({ id: 'stub-tx' } as unknown as AuthTransaction);
  }

  asSequelize(): Sequelize {
    return this as unknown as Sequelize;
  }

  get lastCall(): RecordedQuery {
    const call = this.calls.at(-1);
    if (call === undefined) throw new Error('no query was executed');
    return call;
  }

  /** Whitespace-normalised, for readable substring assertions. */
  get lastSql(): string {
    return this.lastCall.sql.replace(/\s+/g, ' ').trim();
  }
}

/**
 * A real `PortalUserEmailCrypto` over T-016's in-memory test keys — see `support/email-crypto.ts`
 * for why this is not a stub. Built once: `buildDefaultRegistry()` does no I/O, but there is no
 * reason for every `build()` to repeat it.
 */
let emailCrypto: PortalUserEmailCrypto;

beforeAll(async () => {
  emailCrypto = await buildEmailCrypto();
});

function build() {
  const db = new StubSequelize();
  return { db, repository: new CredentialRepository(db.asSequelize(), emailCrypto) };
}

/** The `email` column as it is actually stored since T-056: an envelope bound to the row's id. */
function encryptedEmail(id: number, address: string): string {
  return emailCrypto.encryptForRow(id, address);
}

/** A complete joined row, as Postgres would return it. */
function joinedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    email: encryptedEmail(42, 'Operator@Example.com'),
    display_name: 'Operator',
    role: 'tenant_admin',
    status: 'active',
    country_id: 3,
    tenant_id: 7,
    merchant_id: null,
    must_change_password: false,
    mfa_enabled: false,
    credential_id: 99,
    password_hash: '$argon2id$v=19$m=19456,t=2,p=1$abc$def',
    password_algo: 'argon2id',
    previous_hashes: ['$argon2id$old'],
    failed_attempts: 2,
    locked_until: null,
    password_expires_at: null,
    ...overrides,
  };
}

describe('CredentialRepository', () => {
  describe('findAuthenticationRecordByEmail', () => {
    it('binds the blind index as a parameter and never concatenates the address', async () => {
      const { db, repository } = build();
      db.responses = [[joinedRow()]];

      await repository.findAuthenticationRecordByEmail("bobby'; DROP TABLE portal_users;--");

      // T-056 moved the predicate off `lower(u.email)`, which cannot match a randomly-IV'd
      // ciphertext, onto the deterministic blind index.
      expect(db.lastSql).toContain('u.email_bidx = :bidx');
      expect(db.lastSql).not.toContain('lower(u.email)');
      expect(db.lastSql).not.toContain('DROP TABLE portal_users');

      // The raw address never reaches SQL at all now — only its HMAC does, which is 64 hex
      // characters and therefore cannot carry an injection payload even in principle.
      const { replacements } = db.lastCall.options;
      expect(Object.keys(replacements ?? {})).toEqual(['bidx']);
      expect(replacements?.bidx).toMatch(/^[0-9a-f]{64}$/);
      expect(String(replacements?.bidx)).not.toContain('DROP TABLE');
    });

    // TC-2 — the property the whole scheme rests on: differing case and surrounding whitespace
    // must produce the *same* index, or a user who types their address differently cannot log in.
    it('TC-2: computes an identical blind index for differing casing and whitespace', async () => {
      const indexFor = async (address: string): Promise<unknown> => {
        const { db, repository } = build();
        db.responses = [[joinedRow()]];
        await repository.findAuthenticationRecordByEmail(address);
        return db.lastCall.options.replacements?.bidx;
      };

      const canonical = await indexFor('foo@bar.com');

      expect(await indexFor('Foo@Bar.com')).toBe(canonical);
      expect(await indexFor('  foo@bar.com  ')).toBe(canonical);
      expect(await indexFor('FOO@BAR.COM')).toBe(canonical);
      // A genuinely different address must not collide.
      expect(await indexFor('foo2@bar.com')).not.toBe(canonical);
    });

    it('excludes soft-deleted accounts', async () => {
      const { db, repository } = build();
      db.responses = [[joinedRow()]];

      await repository.findAuthenticationRecordByEmail('operator@example.com');

      // portal_users is paranoid; raw SQL gets none of Sequelize's automatic filtering, so
      // this predicate is what stops a deleted account from logging in.
      expect(db.lastSql).toContain('u.deleted_at IS NULL');
    });

    it('fetches the user and credential in a single statement (timing parity)', async () => {
      const { db, repository } = build();
      db.responses = [[joinedRow()]];

      await repository.findAuthenticationRecordByEmail('operator@example.com');

      expect(db.calls).toHaveLength(1);
      expect(db.lastSql).toContain('LEFT JOIN reward_portal.portal_user_credentials');
    });

    it('does not select mfa_secret_enc', async () => {
      const { db, repository } = build();
      db.responses = [[joinedRow()]];

      await repository.findAuthenticationRecordByEmail('operator@example.com');

      expect(db.lastSql).not.toContain('mfa_secret_enc');
    });

    it('maps a full row into the port shape', async () => {
      const { db, repository } = build();
      db.responses = [[joinedRow()]];

      const record = await repository.findAuthenticationRecordByEmail('operator@example.com');

      expect(record).toEqual({
        user: {
          id: 42,
          email: 'Operator@Example.com',
          displayName: 'Operator',
          role: 'tenant_admin',
          status: 'active',
          countryId: 3,
          tenantId: 7,
          merchantId: null,
          mustChangePassword: false,
          mfaEnabled: false,
        },
        credential: {
          id: 99,
          userId: 42,
          passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$abc$def',
          passwordAlgo: 'argon2id',
          previousHashes: ['$argon2id$old'],
          failedAttempts: 2,
          lockedUntil: null,
          passwordExpiresAt: null,
        },
      });
    });

    it('returns null when the address matches no account', async () => {
      const { db, repository } = build();
      db.responses = [[]];

      expect(await repository.findAuthenticationRecordByEmail('nobody@example.com')).toBeNull();
    });

    // TC-5 — the enumeration-safety property T-010 established, re-proven after the predicate
    // change. The hit and the miss must do the same amount of *database* work; if the encrypted
    // lookup had been implemented as "fetch candidates, decrypt, compare", the miss would issue a
    // different number of statements and the difference would be measurable from outside.
    it('TC-5: issues exactly one statement of the same shape whether or not the account exists', async () => {
      const hit = build();
      hit.db.responses = [[joinedRow()]];
      await hit.repository.findAuthenticationRecordByEmail('operator@example.com');

      const miss = build();
      miss.db.responses = [[]];
      await miss.repository.findAuthenticationRecordByEmail('nobody@example.com');

      expect(hit.db.calls).toHaveLength(1);
      expect(miss.db.calls).toHaveLength(1);
      // Same statement text, and the same single bound parameter name — only its value differs.
      expect(miss.db.lastSql).toBe(hit.db.lastSql);
      expect(Object.keys(miss.db.lastCall.options.replacements ?? {})).toEqual(
        Object.keys(hit.db.lastCall.options.replacements ?? {}),
      );
    });

    it('decrypts the stored envelope back into the address (raw SQL gets no afterFind hook)', async () => {
      const { db, repository } = build();
      const stored = encryptedEmail(42, 'Operator@Example.com');
      db.responses = [[joinedRow({ email: stored })]];

      const record = await repository.findAuthenticationRecordByEmail('operator@example.com');

      expect(stored).toMatch(/^v1\./); // the column really did hold an envelope
      expect(record?.user.email).toBe('Operator@Example.com');
    });

    /**
     * A ciphertext bound to a *different* row must not silently decrypt — that binding is the
     * whole point of the AAD (07-DATA-PROTECTION.md §4). The row still authenticates (the password
     * check is independent of this field), but the address degrades to the sentinel rather than
     * either throwing or, far worse, returning another user's address.
     */
    it('returns the sentinel rather than throwing when the ciphertext is bound to another row', async () => {
      const { db, repository } = build();
      db.responses = [[joinedRow({ email: encryptedEmail(999, 'someone.else@example.com') })]];

      const record = await repository.findAuthenticationRecordByEmail('operator@example.com');

      expect(record?.user.email).toBe('<undecryptable>');
      expect(record?.credential).not.toBeNull();
    });

    it('passes a legacy plaintext value through unchanged (pre-migration rows)', async () => {
      const { db, repository } = build();
      db.responses = [[joinedRow({ email: 'legacy@example.com' })]];

      const record = await repository.findAuthenticationRecordByEmail('legacy@example.com');

      expect(record?.user.email).toBe('legacy@example.com');
    });

    it('returns a user with a null credential when the credential row is missing', async () => {
      const { db, repository } = build();
      db.responses = [
        [
          joinedRow({
            credential_id: null,
            password_hash: null,
            password_algo: null,
            failed_attempts: null,
          }),
        ],
      ];

      const record = await repository.findAuthenticationRecordByEmail('operator@example.com');

      expect(record?.user.id).toBe(42);
      expect(record?.credential).toBeNull();
    });

    it('degrades gracefully if the join yields a credential id but null detail columns', async () => {
      // Not reachable through the real schema (those columns are NOT NULL) — covered so the
      // defensive fallbacks cannot rot into a crash if that ever changes.
      const { db, repository } = build();
      db.responses = [
        [joinedRow({ password_hash: null, password_algo: null, failed_attempts: null })],
      ];

      const record = await repository.findAuthenticationRecordByEmail('operator@example.com');

      expect(record?.credential).toMatchObject({
        passwordHash: '',
        passwordAlgo: '',
        failedAttempts: 0,
      });
    });
  });

  describe('findCredentialByUserId', () => {
    it('binds the user id and maps the row', async () => {
      const { db, repository } = build();
      db.responses = [
        [
          {
            id: 99,
            user_id: 42,
            password_hash: '$argon2id$hash',
            password_algo: 'argon2id',
            previous_hashes: ['$argon2id$older'],
            failed_attempts: 1,
            locked_until: null,
            password_expires_at: null,
          },
        ],
      ];

      const credential = await repository.findCredentialByUserId(42);

      expect(db.lastCall.options.replacements).toEqual({ userId: 42 });
      expect(credential).toEqual({
        id: 99,
        userId: 42,
        passwordHash: '$argon2id$hash',
        passwordAlgo: 'argon2id',
        previousHashes: ['$argon2id$older'],
        failedAttempts: 1,
        lockedUntil: null,
        passwordExpiresAt: null,
      });
    });

    it('returns null when the user has no credential row', async () => {
      const { db, repository } = build();
      db.responses = [[]];

      expect(await repository.findCredentialByUserId(42)).toBeNull();
    });
  });

  describe('previous_hashes parsing', () => {
    async function parseVia(value: unknown): Promise<string[] | null> {
      const { db, repository } = build();
      db.responses = [[joinedRow({ previous_hashes: value })]];
      const record = await repository.findAuthenticationRecordByEmail('operator@example.com');
      return record?.credential?.previousHashes ?? null;
    }

    it('accepts a parsed jsonb array', async () => {
      expect(await parseVia(['a', 'b'])).toEqual(['a', 'b']);
    });

    it('accepts a JSON string, for drivers that hand back raw text', async () => {
      expect(await parseVia('["a","b"]')).toEqual(['a', 'b']);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['malformed JSON', '{not json'],
      ['a JSON object', '{"a":1}'],
      ['a bare number', 7],
      ['an empty array', []],
    ])('degrades %s to null rather than throwing', async (_label, value) => {
      // A corrupt history column must not be able to block a password change; the policy's
      // other rules still apply.
      expect(await parseVia(value)).toBeNull();
    });

    it('drops non-string entries but keeps the usable ones', async () => {
      expect(await parseVia(['a', 3, null, 'b'])).toEqual(['a', 'b']);
    });
  });

  describe('recordLoginAttempt', () => {
    const base = {
      email: 'operator@example.com',
      userId: 42,
      success: false,
      failureCode: 'bad_password' as const,
      ipAddress: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    };

    it('binds every value and casts the address to inet', async () => {
      const { db, repository } = build();

      await repository.recordLoginAttempt(base);

      expect(db.lastSql).toContain('INSERT INTO reward_portal.portal_login_attempts');
      expect(db.lastSql).toContain('CAST(:ipAddress AS inet)');
      expect(db.lastCall.options.replacements).toEqual({
        email: 'operator@example.com',
        userId: 42,
        success: false,
        failureCode: 'bad_password',
        ipAddress: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
      });
    });

    it('stores the email as submitted, without normalising it (forensic data)', async () => {
      const { db, repository } = build();

      await repository.recordLoginAttempt({ ...base, email: '  Operator@EXAMPLE.com ' });

      expect(db.lastCall.options.replacements?.email).toBe('  Operator@EXAMPLE.com ');
    });

    it('truncates an oversized email to the column width', async () => {
      const { db, repository } = build();
      const long = `${'e'.repeat(400)}@example.com`;

      await repository.recordLoginAttempt({ ...base, email: long });

      expect(db.lastCall.options.replacements?.email).toHaveLength(LOGIN_ATTEMPT_EMAIL_MAX_LENGTH);
    });

    it('truncates an oversized user agent to the column width', async () => {
      const { db, repository } = build();

      await repository.recordLoginAttempt({ ...base, userAgent: 'u'.repeat(1000) });

      expect(db.lastCall.options.replacements?.userAgent).toHaveLength(
        LOGIN_ATTEMPT_USER_AGENT_MAX_LENGTH,
      );
    });

    it('passes a null user agent through unchanged', async () => {
      const { db, repository } = build();

      await repository.recordLoginAttempt({ ...base, userAgent: null });

      expect(db.lastCall.options.replacements?.userAgent).toBeNull();
    });

    it('forwards the transaction when one is supplied', async () => {
      const { db, repository } = build();
      const tx = { id: 'tx' } as unknown as AuthTransaction;

      await repository.recordLoginAttempt(base, tx);

      expect(db.lastCall.options.transaction).toBe(tx);
    });

    describe('ip_address sanitising', () => {
      async function storedIp(value: string | null): Promise<unknown> {
        const { db, repository } = build();
        await repository.recordLoginAttempt({ ...base, ipAddress: value });
        return db.lastCall.options.replacements?.ipAddress;
      }

      it.each([
        ['IPv4', '203.0.113.7'],
        ['IPv4 loopback', '127.0.0.1'],
        ['IPv6', '2001:db8::1'],
        ['IPv6 loopback', '::1'],
        ['IPv4-mapped IPv6', '::ffff:127.0.0.1'],
      ])('keeps a valid %s address', async (_label, value) => {
        expect(await storedIp(value)).toBe(value);
      });

      it('trims surrounding whitespace', async () => {
        expect(await storedIp('  203.0.113.7  ')).toBe('203.0.113.7');
      });

      it.each([
        ['null', null],
        ['empty', ''],
        ['whitespace only', '   '],
        ['an out-of-range octet', '999.0.113.7'],
        ['a hostname', 'evil.example.com'],
        ['a SQL fragment', "1.1.1.1'; DROP TABLE x;--"],
        ['hex without colons', 'deadbeef'],
      ])('stores %s as NULL rather than failing the INSERT', async (_label, value) => {
        // Losing one forensic field beats losing the whole attempt record — "this attempt was
        // never logged" is what an attacker would be aiming for.
        expect(await storedIp(value)).toBeNull();
      });
    });
  });

  describe('updateLockState', () => {
    it('binds the counter and the lock timestamp', async () => {
      const { db, repository } = build();
      const lockedUntil = new Date('2026-08-17T10:15:00.000Z');

      await repository.updateLockState(99, { failedAttempts: 5, lockedUntil });

      expect(db.lastSql).toContain('UPDATE reward_portal.portal_user_credentials');
      expect(db.lastSql).toContain('WHERE id = :credentialId');
      expect(db.lastCall.options.replacements).toEqual({
        credentialId: 99,
        failedAttempts: 5,
        lockedUntil,
      });
    });

    it('forwards the transaction when one is supplied', async () => {
      const { db, repository } = build();
      const tx = { id: 'tx' } as unknown as AuthTransaction;

      await repository.updateLockState(99, { failedAttempts: 0, lockedUntil: null }, tx);

      expect(db.lastCall.options.transaction).toBe(tx);
    });
  });

  describe('replacePassword', () => {
    it('serialises the history array and casts it to jsonb', async () => {
      const { db, repository } = build();

      await repository.replacePassword(99, {
        passwordHash: '$argon2id$new',
        passwordAlgo: 'argon2id',
        previousHashes: ['$argon2id$old1', '$argon2id$old2'],
      });

      expect(db.lastSql).toContain('CAST(:previousHashes AS jsonb)');
      // A raw JS array would be expanded by Sequelize into a comma-separated SQL list —
      // valid syntax, wrong value.
      expect(db.lastCall.options.replacements?.previousHashes).toBe(
        '["$argon2id$old1","$argon2id$old2"]',
      );
    });

    it('refreshes password_updated_at', async () => {
      const { db, repository } = build();

      await repository.replacePassword(99, {
        passwordHash: '$argon2id$new',
        passwordAlgo: 'argon2id',
        previousHashes: [],
      });

      expect(db.lastSql).toContain('password_updated_at = now()');
    });

    it('does not touch failed_attempts or locked_until', async () => {
      // Unlocking is an explicit decision made at the call site (LockoutService.clear), never
      // an implicit side effect of changing a password.
      const { db, repository } = build();

      await repository.replacePassword(99, {
        passwordHash: '$argon2id$new',
        passwordAlgo: 'argon2id',
        previousHashes: [],
      });

      expect(db.lastSql).not.toContain('failed_attempts');
      expect(db.lastSql).not.toContain('locked_until');
    });

    it('forwards the transaction when one is supplied', async () => {
      const { db, repository } = build();
      const tx = { id: 'tx' } as unknown as AuthTransaction;

      await repository.replacePassword(
        99,
        { passwordHash: 'h', passwordAlgo: 'argon2id', previousHashes: [] },
        tx,
      );

      expect(db.lastCall.options.transaction).toBe(tx);
    });

    // T-161. The behavioural proof that the column actually ends up NULL lives in
    // `t161-forced-password-change.e2e-spec.ts`, against real Postgres — these two cases pin the
    // flag's *routing*, which is the part a fake store cannot get wrong on the e2e path.
    it('asks Postgres to clear password_expires_at when the caller says this is a real change', async () => {
      const { db, repository } = build();

      await repository.replacePassword(99, {
        passwordHash: '$argon2id$new',
        passwordAlgo: 'argon2id',
        previousHashes: [],
        clearPasswordExpiry: true,
      });

      expect(db.lastSql).toContain('password_expires_at');
      expect(db.lastCall.options.replacements?.clearPasswordExpiry).toBe(true);
    });

    it('defaults to leaving password_expires_at alone when the flag is omitted', async () => {
      // The opportunistic-rehash path (`AuthService.rehashIfNeeded`) omits it. If this defaulted
      // the other way, logging in with a freshly-issued temporary password would silently disarm
      // its own 72-hour deadline whenever the stored hash happened to be due a work-factor upgrade.
      const { db, repository } = build();

      await repository.replacePassword(99, {
        passwordHash: '$argon2id$new',
        passwordAlgo: 'argon2id',
        previousHashes: [],
      });

      expect(db.lastCall.options.replacements?.clearPasswordExpiry).toBe(false);
    });
  });

  describe('runInTransaction', () => {
    it('runs the callback inside a Sequelize transaction and returns its result', async () => {
      const { repository } = build();

      const result = await repository.runInTransaction(async (tx) => {
        expect(tx).toBeDefined();
        return 'done';
      });

      expect(result).toBe('done');
    });
  });
});
