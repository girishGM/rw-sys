/**
 * T-018 — `SessionTransportKeyRepository`, the only door to `portal_sessions.transport_key_enc`.
 *
 * A statement-shape test against a stubbed `Sequelize`, in the same style and for the same
 * reasons as `session.repository.spec.ts`. It pins the properties that are security controls
 * rather than query semantics:
 *
 *  - every caller-supplied value is a **bound replacement**, never concatenated into SQL;
 *  - `store` and `find` both carry `status = 'active'`, which is what makes *every* revocation
 *    path — logout, password change, reuse detection, tenant suspension — destroy the transport
 *    key without knowing this column exists;
 *  - the two `clear` statements deliberately have **no** status predicate, so a key can always be
 *    removed from a session that has already been revoked.
 *
 * Whether the SQL returns the right rows against real Postgres is proven by
 * `transport-crypto.e2e-spec.ts`.
 */
import type { Sequelize } from 'sequelize-typescript';
import { SessionTransportKeyRepository } from '@/common/transport-crypto/session-transport-key.repository';

interface RecordedQuery {
  sql: string;
  options: { replacements?: Record<string, unknown> };
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

  get lastSql(): string {
    const call = this.calls.at(-1);
    if (call === undefined) throw new Error('no query was executed');
    return call.sql.replace(/\s+/g, ' ').trim();
  }

  get lastReplacements(): Record<string, unknown> {
    return this.calls.at(-1)?.options.replacements ?? {};
  }
}

const SESSION_ID = '3f6a1c88-3f2b-4a1e-9d21-6b0a7c9e5d44';
const CIPHERTEXT = 'v1.fld_2026_01.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB==.CCCC';

function build(): { db: StubSequelize; repository: SessionTransportKeyRepository } {
  const db = new StubSequelize();
  return { db, repository: new SessionTransportKeyRepository(db.asSequelize()) };
}

describe('store', () => {
  it('updates only an active session, with bound values', async () => {
    const { db, repository } = build();
    db.responses = [[[], 1]];

    await expect(repository.store(SESSION_ID, CIPHERTEXT)).resolves.toBe(true);

    expect(db.lastSql).toContain('UPDATE reward_portal.portal_sessions');
    expect(db.lastSql).toContain('SET transport_key_enc = :ciphertext');
    expect(db.lastSql).toContain("WHERE id = :sessionId AND status = 'active'");
    expect(db.lastReplacements).toEqual({ sessionId: SESSION_ID, ciphertext: CIPHERTEXT });
    // The ciphertext must never appear in the statement text itself.
    expect(db.lastSql).not.toContain(CIPHERTEXT);
    expect(db.lastSql).not.toContain(SESSION_ID);
  });

  it('reports false when no active session matched', async () => {
    const { db, repository } = build();
    db.responses = [[[], 0]];
    await expect(repository.store(SESSION_ID, CIPHERTEXT)).resolves.toBe(false);
  });
});

describe('find', () => {
  it('selects the column for an active session only', async () => {
    const { db, repository } = build();
    db.responses = [[{ transport_key_enc: CIPHERTEXT }]];

    await expect(repository.find(SESSION_ID)).resolves.toBe(CIPHERTEXT);

    expect(db.lastSql).toContain('SELECT transport_key_enc');
    expect(db.lastSql).toContain("WHERE id = :sessionId AND status = 'active'");
    expect(db.lastReplacements).toEqual({ sessionId: SESSION_ID });
  });

  it('is null when the session row does not exist or is not active (TC-14)', async () => {
    const { db, repository } = build();
    db.responses = [[]];
    await expect(repository.find(SESSION_ID)).resolves.toBeNull();
  });

  it('is null when the session exists but never handshook', async () => {
    const { db, repository } = build();
    db.responses = [[{ transport_key_enc: null }]];
    await expect(repository.find(SESSION_ID)).resolves.toBeNull();
  });
});

describe('clearForSession', () => {
  it('nulls the column with no status predicate, so a revoked session can still be cleaned', async () => {
    const { db, repository } = build();
    db.responses = [[[], 1]];

    await expect(repository.clearForSession(SESSION_ID)).resolves.toBe(1);

    expect(db.lastSql).toContain('SET transport_key_enc = NULL');
    expect(db.lastSql).toContain('WHERE id = :sessionId AND transport_key_enc IS NOT NULL');
    expect(db.lastSql).not.toContain("status = 'active'");
    expect(db.lastReplacements).toEqual({ sessionId: SESSION_ID });
  });
});

describe('clearForUser', () => {
  it('nulls every session the user owns — the logout-all breadth', async () => {
    const { db, repository } = build();
    db.responses = [[[], 3]];

    await expect(repository.clearForUser(42)).resolves.toBe(3);

    expect(db.lastSql).toContain('WHERE user_id = :userId AND transport_key_enc IS NOT NULL');
    expect(db.lastReplacements).toEqual({ userId: 42 });
    expect(db.lastSql).not.toContain('42');
  });
});

describe('R2 — no model statics', () => {
  it('every statement is raw parameterised SQL through the shared Sequelize instance', async () => {
    const { db, repository } = build();
    db.responses = [[[], 1], [[]], [[], 1], [[], 1]];

    await repository.store(SESSION_ID, CIPHERTEXT);
    await repository.find(SESSION_ID);
    await repository.clearForSession(SESSION_ID);
    await repository.clearForUser(42);

    expect(db.calls).toHaveLength(4);
    for (const call of db.calls) {
      // Nothing caller-supplied is spliced into the text: the only interpolated literal is the
      // frozen `'active'` status constant, for the partial-index reason session.repository.ts
      // documents.
      expect(call.sql).not.toContain(SESSION_ID);
      expect(call.options.replacements).toBeDefined();
    }
  });
});
