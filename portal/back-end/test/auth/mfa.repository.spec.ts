/**
 * T-055 — `MfaRepository`, the MFA layer's only door to the database.
 *
 * Driven against a stubbed `Sequelize` that records what it was asked to run, exactly as
 * `session.repository.spec.ts` does for T-011, and for the same reason: this is a *statement
 * shape* test, pinning the properties that are security controls rather than query semantics —
 *
 *  - every caller-supplied value arrives as a **bound replacement**, never concatenated;
 *  - `deleted_at IS NULL` guards every read and every write of `portal_users`, because raw SQL
 *    gets none of Sequelize's paranoid filtering;
 *  - a recovery code is matched by `user_id` **and** hash, so a bug that mixed two users' codes
 *    up would fail closed;
 *  - consumption is a single `UPDATE … WHERE used_at IS NULL`, which is what makes it atomic;
 *  - clearing MFA nulls the seed as well as the flag.
 *
 * Whether the SQL returns the right rows against real Postgres is proven by `mfa.e2e-spec.ts`.
 */
import type { Sequelize } from 'sequelize-typescript';
import { MfaRepository } from '@/modules/auth/services/mfa.repository';
import type { AuthTransaction } from '@/modules/auth/services/credential.repository';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import { buildEmailCrypto } from './support/email-crypto';

interface RecordedQuery {
  sql: string;
  options: { replacements?: Record<string, unknown>; transaction?: AuthTransaction };
}

class StubSequelize {
  readonly calls: RecordedQuery[] = [];
  responses: unknown[] = [];

  async query(sql: string, options: RecordedQuery['options']): Promise<unknown> {
    this.calls.push({ sql, options });
    return this.responses.shift() ?? [];
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

  sqlAt(index: number): string {
    return this.calls[index].sql.replace(/\s+/g, ' ').trim();
  }
}

/** Real crypto over test keys — see `support/email-crypto.ts` for why this is not a stub. */
let emailCrypto: PortalUserEmailCrypto;

beforeAll(async () => {
  emailCrypto = await buildEmailCrypto();
});

function build() {
  const db = new StubSequelize();
  return { db, repository: new MfaRepository(db.asSequelize(), emailCrypto) };
}

const TX = { id: 'stub-tx' } as unknown as AuthTransaction;
const NOW = new Date('2026-08-18T10:00:00.000Z');

const USER_ROW = {
  id: 42,
  email: 'super@example.invalid',
  display_name: 'Super Admin',
  role: 'super_admin',
  status: 'active',
  country_id: null,
  tenant_id: null,
  merchant_id: null,
  must_change_password: false,
  mfa_enabled: true,
  mfa_secret_enc: 'v1.kid.iv.tag.ct',
};

describe('findUserForMfa', () => {
  it('maps the row and binds the id', async () => {
    const { db, repository } = build();
    db.responses = [[USER_ROW]];

    const user = await repository.findUserForMfa(42);

    expect(user).toEqual({
      id: 42,
      email: 'super@example.invalid',
      displayName: 'Super Admin',
      role: 'super_admin',
      status: 'active',
      countryId: null,
      tenantId: null,
      merchantId: null,
      mustChangePassword: false,
      mfaEnabled: true,
      secretEnc: 'v1.kid.iv.tag.ct',
    });
    expect(db.lastCall.options.replacements).toEqual({ userId: 42 });
    expect(db.lastSql).toContain('WHERE id = :userId AND deleted_at IS NULL');
    expect(db.lastSql).not.toContain('42');
  });

  it('returns null for a row that is absent or soft-deleted', async () => {
    const { db, repository } = build();
    db.responses = [[]];

    await expect(repository.findUserForMfa(42)).resolves.toBeNull();
  });

  /**
   * T-056. `MfaService` renders this value as the account label inside the `otpauth://` URI, so an
   * undecrypted envelope would be baked into the QR code the user scans — unfixable afterwards
   * without re-enrolling them.
   */
  it('decrypts the stored email envelope', async () => {
    const { db, repository } = build();
    const stored = emailCrypto.encryptForRow(42, 'super@example.invalid');
    db.responses = [[{ ...USER_ROW, email: stored }]];

    const user = await repository.findUserForMfa(42);

    expect(stored).toMatch(/^v1\./);
    expect(user?.email).toBe('super@example.invalid');
  });

  it('passes a transaction through when one is given', async () => {
    const { db, repository } = build();
    db.responses = [[USER_ROW]];

    await repository.findUserForMfa(42, TX);

    expect(db.lastCall.options.transaction).toBe(TX);
  });
});

describe('isMfaEnabled', () => {
  it('reads the single column, soft-delete aware, and reports null for an absent user', async () => {
    const { db, repository } = build();
    db.responses = [[{ mfa_enabled: false }], []];

    await expect(repository.isMfaEnabled(42)).resolves.toBe(false);
    expect(db.lastSql).toContain('SELECT mfa_enabled');
    expect(db.lastSql).toContain('deleted_at IS NULL');

    await expect(repository.isMfaEnabled(42)).resolves.toBeNull();
  });
});

describe('storeSecret / enableMfa / clearMfa', () => {
  it('writes the ciphertext as a bound value and does not touch mfa_enabled', async () => {
    const { db, repository } = build();

    await repository.storeSecret(42, 'v1.kid.iv.tag.ct', TX);

    expect(db.lastCall.options.replacements).toEqual({
      userId: 42,
      secretEnc: 'v1.kid.iv.tag.ct',
    });
    expect(db.lastSql).toContain('SET mfa_secret_enc = :secretEnc');
    expect(db.lastSql).not.toContain('mfa_enabled');
    expect(db.lastSql).toContain('deleted_at IS NULL');
  });

  it('enables the flag without touching the seed', async () => {
    const { db, repository } = build();

    await repository.enableMfa(42);

    expect(db.lastSql).toContain('SET mfa_enabled = true');
    expect(db.lastSql).not.toContain('mfa_secret_enc');
  });

  it('clears the flag AND nulls the seed — a reset is not one boolean away from undone', async () => {
    const { db, repository } = build();

    await repository.clearMfa(42, TX);

    expect(db.lastSql).toContain('SET mfa_enabled = false, mfa_secret_enc = NULL');
    expect(db.lastCall.options.transaction).toBe(TX);
  });
});

describe('recovery codes', () => {
  it('inserts every digest in one statement, as a bound array', async () => {
    const { db, repository } = build();

    await repository.insertRecoveryCodes(42, ['aa', 'bb', 'cc'], TX);

    expect(db.lastSql).toContain('INSERT INTO reward_portal.portal_mfa_recovery_codes');
    expect(db.lastSql).toContain('json_array_elements_text(CAST(:codeHashes AS json))');
    // A JSON *string*, not a JS array: Sequelize expands an array replacement into a
    // comma-separated list, which is a syntax error in this position. See the method's comment —
    // this assertion exists because the array form shipped once and failed against real Postgres.
    expect(db.lastCall.options.replacements).toEqual({
      userId: 42,
      codeHashes: '["aa","bb","cc"]',
    });
  });

  it('runs no statement at all for an empty list', async () => {
    const { db, repository } = build();

    await repository.insertRecoveryCodes(42, []);

    expect(db.calls).toHaveLength(0);
  });

  it('invalidates only the unused ones, and reports how many', async () => {
    const { db, repository } = build();
    db.responses = [[undefined, 4]];

    await expect(repository.invalidateRecoveryCodes(42, NOW, TX)).resolves.toBe(4);
    expect(db.lastSql).toContain('SET used_at = :at');
    expect(db.lastSql).toContain('WHERE user_id = :userId AND used_at IS NULL');
  });

  it('consumes atomically, matching on user_id and hash together', async () => {
    const { db, repository } = build();
    db.responses = [[{ id: 1 }]];

    await expect(repository.consumeRecoveryCode(42, 'digest', NOW)).resolves.toBe('consumed');

    expect(db.lastSql).toContain(
      'WHERE user_id = :userId AND code_hash = :codeHash AND used_at IS NULL',
    );
    expect(db.lastSql).toContain('RETURNING id');
    expect(db.lastCall.options.replacements).toEqual({
      userId: 42,
      codeHash: 'digest',
      at: NOW,
    });
    // One round trip on the success path — the existence check only runs when nothing updated.
    expect(db.calls).toHaveLength(1);
  });

  it('distinguishes a spent code from one that never existed (TC-12)', async () => {
    const { db, repository } = build();
    db.responses = [[], [{ id: 1 }]];
    await expect(repository.consumeRecoveryCode(42, 'digest', NOW)).resolves.toBe('already_used');
    expect(db.sqlAt(1)).toContain('SELECT id');

    const second = build();
    second.db.responses = [[], []];
    await expect(second.repository.consumeRecoveryCode(42, 'digest', NOW)).resolves.toBe('unknown');
  });

  it('counts the unused codes, parsing the bigint Postgres returns as text', async () => {
    const { db, repository } = build();
    db.responses = [[{ remaining: '7' }]];

    await expect(repository.countUnusedRecoveryCodes(42, TX)).resolves.toBe(7);
    expect(db.lastSql).toContain('count(*)::text');
    expect(db.lastCall.options.transaction).toBe(TX);
  });
});

describe('SQL hygiene', () => {
  it('never concatenates a caller-supplied value into a statement', async () => {
    const { db, repository } = build();
    db.responses = [
      [USER_ROW], // findUserForMfa
      [{ mfa_enabled: true }], // isMfaEnabled
      [], // storeSecret (an UPDATE returns nothing this stub cares about)
      [{ id: 1 }], // consumeRecoveryCode
      [{ remaining: '1' }], // countUnusedRecoveryCodes
    ];

    await repository.findUserForMfa(1234567);
    await repository.isMfaEnabled(1234567);
    await repository.storeSecret(1234567, 'SECRET-CIPHERTEXT');
    await repository.consumeRecoveryCode(1234567, 'A-DIGEST', NOW);
    await repository.countUnusedRecoveryCodes(1234567);

    for (const call of db.calls) {
      expect(call.sql).not.toContain('1234567');
      expect(call.sql).not.toContain('SECRET-CIPHERTEXT');
      expect(call.sql).not.toContain('A-DIGEST');
    }
  });
});
