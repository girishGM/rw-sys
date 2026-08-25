/**
 * T-011 — `SessionRepository`, the session layer's only door to the database.
 *
 * Driven against a stubbed `Sequelize` that records what it was asked to run, exactly as
 * `credential.repository.spec.ts` does for T-010. This is deliberately a *statement-shape* test
 * rather than a SQL-correctness test: it pins the properties that are security controls rather
 * than query semantics —
 *
 *  - every caller-supplied value arrives as a **bound replacement**, never concatenated;
 *  - the refresh-token lookup takes `FOR UPDATE`, which is the whole of the concurrency argument
 *    for reuse detection;
 *  - the ownership predicate on a single session is in the **WHERE clause**, not a post-fetch
 *    comparison, so another user's session is unreachable rather than reachable-and-rejected;
 *  - `token_hash` is never selected, so it cannot be serialised into a response by accident;
 *  - `deleted_at IS NULL` guards the user re-read, because raw SQL gets none of Sequelize's
 *    paranoid filtering.
 *
 * Whether the SQL returns the right rows against real Postgres is proven by `auth.e2e-spec.ts`.
 */
import type { Sequelize } from 'sequelize-typescript';
import {
  SessionRepository,
  type AuditEventInput,
} from '@/modules/auth/services/session.repository';
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

/** Real crypto over test keys — see `support/email-crypto.ts` for why this is not a stub. */
let emailCrypto: PortalUserEmailCrypto;

beforeAll(async () => {
  emailCrypto = await buildEmailCrypto();
});

function build() {
  const db = new StubSequelize();
  return { db, repository: new SessionRepository(db.asSequelize(), emailCrypto) };
}

const TX = { id: 'stub-tx' } as unknown as AuthTransaction;
const NOW = new Date('2026-08-17T10:00:00.000Z');
const SESSION_ID = '2b1c9f3a-4d5e-4a6b-8c7d-9e0f1a2b3c4d';

const SESSION_ROW = {
  id: SESSION_ID,
  user_id: 42,
  status: 'active',
  ip_address: '203.0.113.7',
  user_agent: 'jest',
  issued_at: NOW,
  last_seen_at: NOW,
  expires_at: NOW,
  revoked_at: null,
  revoked_reason: null,
};

describe('createSession', () => {
  it('lets the database mint the id and binds every caller-supplied value', async () => {
    const { db, repository } = build();
    db.responses = [[SESSION_ROW]];

    const row = await repository.createSession(
      {
        userId: 42,
        ipAddress: '203.0.113.7',
        userAgent: 'jest',
        issuedAt: NOW,
        expiresAt: NOW,
      },
      TX,
    );

    expect(db.lastSql).toContain('INSERT INTO reward_portal.portal_sessions');
    // Not in the column list: `id`. The client never proposes a session identifier.
    expect(db.lastSql).not.toMatch(/\(\s*id\s*,/);
    expect(db.lastCall.options.replacements).toEqual({
      userId: 42,
      ipAddress: '203.0.113.7',
      userAgent: 'jest',
      issuedAt: NOW,
      expiresAt: NOW,
    });
    expect(db.lastCall.options.transaction).toBe(TX);
    expect(row.id).toBe(SESSION_ID);
  });

  it('casts the address so a malformed value cannot corrupt the statement', async () => {
    const { db, repository } = build();
    db.responses = [[SESSION_ROW]];

    await repository.createSession({
      userId: 1,
      ipAddress: null,
      userAgent: null,
      issuedAt: NOW,
      expiresAt: NOW,
    });

    expect(db.lastSql).toContain('CAST(:ipAddress AS inet)');
  });
});

describe('insertRefreshToken', () => {
  it('stores the digest and the parent link, and returns the new id', async () => {
    const { db, repository } = build();
    db.responses = [[{ id: 'token-1' }]];

    const id = await repository.insertRefreshToken({
      sessionId: SESSION_ID,
      userId: 42,
      tokenHash: 'a'.repeat(64),
      parentTokenId: 'token-0',
      issuedAt: NOW,
      expiresAt: NOW,
    });

    expect(id).toBe('token-1');
    expect(db.lastSql).toContain('INSERT INTO reward_portal.portal_refresh_tokens');
    expect(db.lastCall.options.replacements).toMatchObject({
      tokenHash: 'a'.repeat(64),
      parentTokenId: 'token-0',
    });
  });
});

describe('lockRefreshTokenByHash', () => {
  it('takes FOR UPDATE — the whole concurrency argument for reuse detection', async () => {
    const { db, repository } = build();
    db.responses = [
      [
        {
          id: 'token-1',
          session_id: SESSION_ID,
          user_id: 42,
          status: 'active',
          issued_at: NOW,
          expires_at: NOW,
          consumed_at: null,
        },
      ],
    ];

    const row = await repository.lockRefreshTokenByHash('deadbeef', TX);

    expect(db.lastSql).toContain('FOR UPDATE');
    expect(db.lastCall.options.transaction).toBe(TX);
    expect(db.lastCall.options.replacements).toEqual({ tokenHash: 'deadbeef' });
    expect(row).toMatchObject({ id: 'token-1', sessionId: SESSION_ID });
  });

  it('never selects token_hash, so it cannot leak into a response', async () => {
    const { db, repository } = build();
    await repository.lockRefreshTokenByHash('x', TX);

    expect(db.lastSql).toMatch(/SELECT id, session_id, user_id, status/);
    expect(db.lastSql).not.toContain('SELECT token_hash');
    expect(db.lastSql.split('FROM')[0]).not.toContain('token_hash');
  });

  it('returns null when there is no such token', async () => {
    const { repository } = build();
    expect(await repository.lockRefreshTokenByHash('nope', TX)).toBeNull();
  });
});

describe('markRefreshTokenConsumed', () => {
  it('only consumes a token that is still active, and reports whether it won', async () => {
    const { db, repository } = build();
    db.responses = [[undefined, 1]];

    const won = await repository.markRefreshTokenConsumed('token-1', NOW, TX);

    expect(won).toBe(true);
    expect(db.lastSql).toContain("status = 'consumed'");
    expect(db.lastSql).toContain("WHERE id = :id AND status = 'active'");
  });

  it('reports false when the row was already consumed by somebody else', async () => {
    const { db, repository } = build();
    db.responses = [[undefined, 0]];

    expect(await repository.markRefreshTokenConsumed('token-1', NOW, TX)).toBe(false);
  });
});

describe('revocation statements', () => {
  it('revokeRefreshTokenFamily targets the whole session and skips already-revoked rows', async () => {
    const { db, repository } = build();
    db.responses = [[undefined, 3]];

    expect(await repository.revokeRefreshTokenFamily(SESSION_ID, TX)).toBe(3);
    expect(db.lastSql).toContain('WHERE session_id = :sessionId');
    expect(db.lastSql).toContain("status <> 'revoked'");
  });

  it('revokeRefreshTokensForUser is one set operation, optionally sparing a session', async () => {
    const { db, repository } = build();
    db.responses = [[undefined, 2]];

    await repository.revokeRefreshTokensForUser(42, SESSION_ID);

    expect(db.lastSql).toContain('WHERE user_id = :userId');
    expect(db.lastSql).toContain('CAST(:exceptSessionId AS uuid)');
    expect(db.lastCall.options.replacements).toEqual({ userId: 42, exceptSessionId: SESSION_ID });
  });

  it('revokeSession records the reason and only touches an active row', async () => {
    const { db, repository } = build();
    db.responses = [[undefined, 1]];

    expect(await repository.revokeSession(SESSION_ID, 'logout')).toBe(1);
    expect(db.lastSql).toContain('revoked_reason = :reason');
    expect(db.lastSql).toContain("WHERE id = :sessionId AND status = 'active'");
  });

  it('revokeSessionsForUser binds the spared session rather than interpolating it', async () => {
    const { db, repository } = build();
    db.responses = [[undefined, 2]];

    expect(await repository.revokeSessionsForUser(42, 'logout_all', null, TX)).toBe(2);
    expect(db.lastCall.options.replacements).toEqual({
      userId: 42,
      reason: 'logout_all',
      exceptSessionId: null,
    });
  });
});

describe('findSessionContext', () => {
  it('joins the user row so revocation and deactivation are one query, not two', async () => {
    const { db, repository } = build();
    db.responses = [
      [
        {
          session_id: SESSION_ID,
          session_status: 'active',
          session_expires_at: NOW,
          last_seen_at: NOW,
          user_id: 42,
          user_status: 'active',
          user_deleted: false,
          must_change_password: true,
          role: 'maker',
          tenant_status: 'active',
          merchant_status: null,
        },
      ],
    ];

    const row = await repository.findSessionContext(SESSION_ID);

    expect(db.lastSql).toContain('JOIN reward_portal.portal_users u ON u.id = s.user_id');
    expect(db.lastSql).toContain('(u.deleted_at IS NOT NULL) AS user_deleted');
    expect(row).toEqual({
      sessionId: SESSION_ID,
      sessionStatus: 'active',
      sessionExpiresAt: NOW,
      lastSeenAt: NOW,
      userId: 42,
      userStatus: 'active',
      userDeleted: false,
      mustChangePassword: true,
      role: 'maker',
      tenantStatus: 'active',
      merchantStatus: null,
    });
  });

  /**
   * T-013 implementation note 9 / AR-10 — the two joins that make a tenant suspension take effect
   * on the next request.
   */
  it('LEFT-joins the parent tenant and merchant statuses (T-013 note 9, AR-10)', async () => {
    const { db, repository } = build();
    db.responses = [[]];

    await repository.findSessionContext(SESSION_ID);

    expect(db.lastSql).toContain('LEFT JOIN reward_config.tenants t ON t.id = u.tenant_id');
    expect(db.lastSql).toContain('LEFT JOIN reward_config.merchants m ON m.id = u.merchant_id');
    expect(db.lastSql).toContain('t.status AS tenant_status');
    expect(db.lastSql).toContain('m.status AS merchant_status');
  });

  it('uses LEFT joins, not inner ones — a super_admin has neither parent', async () => {
    // An inner join here would return no row for a NULL `tenant_id` and log every Super Admin
    // and Country Admin out. Asserted on the SQL text because the consequence is total.
    const { db, repository } = build();
    db.responses = [[]];

    await repository.findSessionContext(SESSION_ID);

    // Negative lookbehind: `\bJOIN` alone matches inside `LEFT JOIN` too, which would make this
    // assertion fail against correct SQL.
    expect(db.lastSql).not.toMatch(/(?<!LEFT )JOIN reward_config\.tenants\b/);
    expect(db.lastSql).not.toMatch(/(?<!LEFT )JOIN reward_config\.merchants\b/);
  });

  it('reports both parent statuses as null when the user has neither', async () => {
    const { db, repository } = build();
    db.responses = [
      [
        {
          session_id: SESSION_ID,
          session_status: 'active',
          session_expires_at: NOW,
          last_seen_at: NOW,
          user_id: 1,
          user_status: 'active',
          user_deleted: false,
          must_change_password: false,
          role: 'super_admin',
          tenant_status: null,
          merchant_status: null,
        },
      ],
    ];

    const row = await repository.findSessionContext(SESSION_ID);

    expect(row).toMatchObject({ tenantStatus: null, merchantStatus: null });
  });

  it('returns null for an unknown session', async () => {
    const { repository } = build();
    expect(await repository.findSessionContext('nope')).toBeNull();
  });

  it("runs inside the caller's transaction when one is supplied", async () => {
    const { db, repository } = build();
    await repository.findSessionContext(SESSION_ID, TX);

    expect(db.lastCall.options.transaction).toBe(TX);
  });
});

describe('session reads scoped to one user', () => {
  it('listSessionsForUser filters by user, status and expiry in the WHERE clause', async () => {
    const { db, repository } = build();
    db.responses = [[SESSION_ROW]];

    const rows = await repository.listSessionsForUser(42, NOW);

    expect(db.lastSql).toContain('WHERE user_id = :userId');
    expect(db.lastSql).toContain("status = 'active'");
    expect(db.lastSql).toContain('expires_at > :now');
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).not.toContain('tokenHash');
  });

  it('TC-25: findSessionForUser puts ownership in the WHERE clause, not a later comparison', async () => {
    const { db, repository } = build();
    db.responses = [[SESSION_ROW]];

    await repository.findSessionForUser(SESSION_ID, 42);

    expect(db.lastSql).toContain('WHERE id = :sessionId AND user_id = :userId');
  });

  it('findSessionForUser returns null when the row belongs to somebody else', async () => {
    const { repository } = build();
    expect(await repository.findSessionForUser(SESSION_ID, 42)).toBeNull();
  });

  it('touchSession only updates an active session', async () => {
    const { db, repository } = build();
    await repository.touchSession(SESSION_ID, NOW);

    expect(db.lastSql).toContain('SET last_seen_at = :at');
    expect(db.lastSql).toContain("status = 'active'");
  });
});

describe('user reads', () => {
  const USER_ROW = {
    id: 42,
    email: 'Operator@Example.com',
    display_name: 'Operator',
    role: 'tenant_admin',
    status: 'active',
    country_id: 3,
    tenant_id: 7,
    merchant_id: null,
    must_change_password: false,
    mfa_enabled: false,
  };

  it('findUserById excludes soft-deleted rows — the paranoid filter raw SQL does not get', async () => {
    const { db, repository } = build();
    db.responses = [[USER_ROW]];

    const row = await repository.findUserById(42);

    expect(db.lastSql).toContain('WHERE id = :userId AND deleted_at IS NULL');
    expect(row).toMatchObject({ role: 'tenant_admin', countryId: 3, tenantId: 7 });
    // `mfa_secret_enc` and `password_hash` are not in the projection at all.
    expect(db.lastSql).not.toContain('mfa_secret_enc');
  });

  it('findUserById returns null for a missing row', async () => {
    const { repository } = build();
    expect(await repository.findUserById(42)).toBeNull();
  });

  /**
   * T-056. This is the row re-read on every refresh, so an undecrypted envelope here would ride
   * out into the re-derived session claims for the whole of the next refresh interval.
   */
  it('findUserById decrypts the stored email envelope', async () => {
    const { db, repository } = build();
    const stored = emailCrypto.encryptForRow(42, 'Operator@Example.com');
    db.responses = [[{ ...USER_ROW, id: 42, email: stored }]];

    const row = await repository.findUserById(42);

    expect(stored).toMatch(/^v1\./);
    expect(row?.email).toBe('Operator@Example.com');
  });

  it('findActiveUserIdByEmail normalises the address and returns nothing but an id', async () => {
    const { db, repository } = build();
    db.responses = [[{ id: 42 }]];

    expect(await repository.findActiveUserIdByEmail('  Operator@Example.COM ')).toBe(42);
    // T-056: `lower(email)` cannot match a randomly-IV'd ciphertext, so the forgot-password
    // lookup moved to the blind index alongside the login lookup.
    expect(db.lastSql).toContain('email_bidx = :bidx');
    expect(db.lastSql).not.toContain('lower(email)');
    expect(db.lastCall.options.replacements?.bidx).toMatch(/^[0-9a-f]{64}$/);
    expect(db.lastSql).toMatch(/SELECT id\b/);
  });

  /**
   * The normalisation still has to be applied — this endpoint answers 204 either way, so if the
   * index were computed from the raw string a user who typed a stray space or a capital would
   * silently get no reset mail and no error. That is the exact failure this assertion exists for.
   */
  it('findActiveUserIdByEmail indexes differing casing and whitespace identically', async () => {
    const indexFor = async (address: string): Promise<unknown> => {
      const { db, repository } = build();
      db.responses = [[{ id: 42 }]];
      await repository.findActiveUserIdByEmail(address);
      return db.lastCall.options.replacements?.bidx;
    };

    const canonical = await indexFor('operator@example.com');
    expect(await indexFor('  Operator@Example.COM ')).toBe(canonical);
    expect(await indexFor('nobody@example.com')).not.toBe(canonical);
  });

  it('findActiveUserIdByEmail returns null for an unknown or inactive account', async () => {
    const { repository } = build();
    expect(await repository.findActiveUserIdByEmail('nobody@example.com')).toBeNull();
  });

  it('recordLastLogin and setMustChangePassword bind their values', async () => {
    const { db, repository } = build();

    await repository.recordLastLogin(42, NOW, TX);
    expect(db.lastCall.options.replacements).toEqual({ userId: 42, at: NOW });

    await repository.setMustChangePassword(42, true);
    expect(db.lastCall.options.replacements).toEqual({ userId: 42, value: true });
  });
});

describe('password resets', () => {
  it('stores the digest and returns the new row id', async () => {
    const { db, repository } = build();
    db.responses = [[{ id: 'reset-1' }]];

    expect(await repository.createPasswordReset(42, 'b'.repeat(64), NOW)).toBe('reset-1');
    expect(db.lastCall.options.replacements).toEqual({
      userId: 42,
      tokenHash: 'b'.repeat(64),
      expiresAt: NOW,
    });
  });

  it('locks the reset row for update, same discipline as the refresh path', async () => {
    const { db, repository } = build();
    db.responses = [[{ id: 'reset-1', user_id: 42, expires_at: NOW, consumed_at: null }]];

    const row = await repository.lockPasswordResetByHash('c'.repeat(64), TX);

    expect(db.lastSql).toContain('FOR UPDATE');
    expect(row).toEqual({ id: 'reset-1', userId: 42, expiresAt: NOW, consumedAt: null });
  });

  it('returns null for an unknown reset token', async () => {
    const { repository } = build();
    expect(await repository.lockPasswordResetByHash('nope', TX)).toBeNull();
  });

  it('consumes only an unconsumed row, so a reset token is genuinely single-use', async () => {
    const { db, repository } = build();
    db.responses = [[undefined, 1]];

    expect(await repository.markPasswordResetConsumed('reset-1', NOW, TX)).toBe(true);
    expect(db.lastSql).toContain('WHERE id = :id AND consumed_at IS NULL');

    db.responses = [[undefined, 0]];
    expect(await repository.markPasswordResetConsumed('reset-1', NOW, TX)).toBe(false);
  });
});

describe('readRbacVersion', () => {
  it('reads the per-role config key', async () => {
    const { db, repository } = build();
    db.responses = [[{ config_value: '7' }]];

    expect(await repository.readRbacVersion('maker')).toBe(7);
    expect(db.lastCall.options.replacements).toEqual({ key: 'rbac_version:maker' });
  });

  it('falls back to 0 when the row is missing', async () => {
    const { repository } = build();
    expect(await repository.readRbacVersion('checker')).toBe(0);
  });

  it('falls back to 0 when the stored value is not a number', async () => {
    const { db, repository } = build();
    db.responses = [[{ config_value: 'latest' }]];

    expect(await repository.readRbacVersion('checker')).toBe(0);
  });
});

describe('writeAuditEvent', () => {
  const EVENT: AuditEventInput = {
    eventType: 'refresh_reuse_detected',
    actorId: 42,
    actorRole: 'maker',
    targetType: 'portal_session',
    targetId: SESSION_ID,
    countryId: 3,
    tenantId: 7,
    ipAddress: '203.0.113.7',
    detail: { replayedTokenId: 'token-1', revokedTokens: 2 },
  };

  it('inserts only — the table is append-only at the privilege level', async () => {
    const { db, repository } = build();
    await repository.writeAuditEvent(EVENT);

    expect(db.lastSql).toContain('INSERT INTO reward_portal.portal_audit_log');
    expect(db.lastSql).not.toMatch(/UPDATE|DELETE/);
  });

  it('stringifies detail and casts it, rather than letting Sequelize expand an object', async () => {
    const { db, repository } = build();
    await repository.writeAuditEvent(EVENT);

    expect(db.lastSql).toContain('CAST(:detail AS jsonb)');
    expect(db.lastCall.options.replacements?.detail).toBe(
      JSON.stringify({ replayedTokenId: 'token-1', revokedTokens: 2 }),
    );
  });

  it('passes a null detail through as SQL NULL, not as the string "null"', async () => {
    const { db, repository } = build();
    await repository.writeAuditEvent({ ...EVENT, detail: null });

    expect(db.lastCall.options.replacements?.detail).toBeNull();
  });
});

describe('runInTransaction', () => {
  it('hands the callback a transaction handle and returns its result', async () => {
    const { repository } = build();

    await expect(repository.runInTransaction(async (tx) => tx)).resolves.toMatchObject({
      id: 'stub-tx',
    });
  });
});

describe('SQL hygiene across every statement', () => {
  it('never interpolates anything but the frozen status literals', async () => {
    const { db, repository } = build();
    db.responses = [[SESSION_ROW], [{ id: 'x' }]];

    await repository.createSession({
      userId: 1,
      ipAddress: '1.2.3.4',
      userAgent: 'ua',
      issuedAt: NOW,
      expiresAt: NOW,
    });
    await repository.insertRefreshToken({
      sessionId: SESSION_ID,
      userId: 1,
      tokenHash: 'h',
      parentTokenId: null,
      issuedAt: NOW,
      expiresAt: NOW,
    });
    await repository.findSessionContext(SESSION_ID);
    await repository.findSessionForUser(SESSION_ID, 1);
    await repository.findUserById(1);
    await repository.findActiveUserIdByEmail('a@b.co');

    for (const call of db.calls) {
      // Any single-quoted literal in these statements must be one of the three row statuses.
      const literals = call.sql.match(/'[^']*'/g) ?? [];
      for (const literal of literals) {
        expect(["'active'", "'consumed'", "'revoked'"]).toContain(literal);
      }
    }
  });
});
