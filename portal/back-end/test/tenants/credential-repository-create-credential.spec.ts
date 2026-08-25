/**
 * T-059 — `CredentialRepository.createCredential`, the additive method this task's fix routes
 * `TenantsService.provisionTenantAdmin` through instead of the denied `scoped.create`.
 *
 * This file lives under `test/tenants/**` — this task's own file scope (AGENT-PROTOCOL R9) —
 * even though the class under test is `credential.repository.ts` (T-010's, additive-only per
 * this task's own "Files owned" note). `test/auth/credential.repository.spec.ts` is T-010's own
 * test file and is out of scope to edit; this file is the in-scope place to prove the one new
 * method it gained, driven against the same kind of stubbed `Sequelize` that file's own
 * `StubSequelize` uses — a statement-shape test, not a Postgres-correctness one (that half is
 * `tenants.service.spec.ts`'s "TC-2/TC-4/TC-5" tests plus this task's live Verification steps
 * against the real database).
 */
import type { Sequelize } from 'sequelize-typescript';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import {
  CredentialRepository,
  type AuthTransaction,
} from '@/modules/auth/services/credential.repository';
import { buildEmailCrypto } from '../auth/support/email-crypto';

interface RecordedQuery {
  sql: string;
  options: { replacements?: Record<string, unknown>; transaction?: AuthTransaction };
}

class StubSequelize {
  readonly calls: RecordedQuery[] = [];

  async query(sql: string, options: RecordedQuery['options']): Promise<unknown[]> {
    this.calls.push({ sql, options });
    return [];
  }

  asSequelize(): Sequelize {
    return this as unknown as Sequelize;
  }

  get lastCall(): RecordedQuery {
    const call = this.calls.at(-1);
    if (call === undefined) throw new Error('no query was executed');
    return call;
  }

  get lastSql(): string {
    return this.lastCall.sql.replace(/\s+/g, ' ').trim();
  }
}

let emailCrypto: PortalUserEmailCrypto;

beforeAll(async () => {
  emailCrypto = await buildEmailCrypto();
});

function build() {
  const db = new StubSequelize();
  return { db, repository: new CredentialRepository(db.asSequelize(), emailCrypto) };
}

describe('CredentialRepository.createCredential', () => {
  it('inserts into portal_user_credentials with the caller-supplied hash and algorithm', async () => {
    const { db, repository } = build();

    await repository.createCredential(42, '$argon2id$v=19$m=19456,t=2,p=1$abc$def', 'argon2id');

    expect(db.lastSql).toContain('INSERT INTO reward_portal.portal_user_credentials');
    expect(db.lastCall.options.replacements).toEqual({
      userId: 42,
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$abc$def',
      passwordAlgo: 'argon2id',
    });
  });

  it("matches bootstrap-superadmin.ts's own first-credential column list — failed_attempts 0, password_updated_at set", async () => {
    const { db, repository } = build();

    await repository.createCredential(1, 'hash', 'argon2id');

    expect(db.lastSql).toContain('failed_attempts');
    expect(db.lastSql).toContain('0');
    expect(db.lastSql).toContain('password_updated_at');
    expect(db.lastSql).toContain('now()');
  });

  it('binds every value — no string concatenation into the statement', async () => {
    const { db, repository } = build();

    await repository.createCredential(7, "'; DROP TABLE portal_user_credentials; --", 'argon2id');

    expect(db.lastSql).not.toContain('DROP TABLE');
    expect(db.lastCall.options.replacements?.passwordHash).toBe(
      "'; DROP TABLE portal_user_credentials; --",
    );
  });

  it('forwards the caller-supplied transaction, so the row can be rolled back with the user (TC-4/TC-5)', async () => {
    const { db, repository } = build();
    const tx = { id: 'tenant-admin-onboarding-tx' } as unknown as AuthTransaction;

    await repository.createCredential(7, 'hash', 'argon2id', tx);

    expect(db.lastCall.options.transaction).toBe(tx);
  });

  it('runs with no transaction at all when none is supplied', async () => {
    const { db, repository } = build();

    await repository.createCredential(7, 'hash', 'argon2id');

    expect(db.lastCall.options.transaction).toBeUndefined();
  });
});
