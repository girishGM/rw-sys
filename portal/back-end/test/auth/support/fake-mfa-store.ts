/**
 * T-055 unit-test support — an in-memory `MfaStore`, in the same spirit as `FakeSessionStore`.
 *
 * **What this double is for.** The MFA layer's security properties are decisions, not SQL: whether
 * a stale pending token is re-checked against the live row, whether a reuse is audited distinctly
 * from a wrong guess, whether an administrative reset invalidates codes as well as clearing the
 * flag. Driving those from memory makes every branch the 100% bar demands reachable
 * deterministically — including the ones a real database will not produce on demand (a user row
 * that vanishes under a live session).
 *
 * **What it is not for.** It is no evidence that the SQL in `mfa.repository.ts` is correct — it
 * never sees that SQL. `mfa.repository.spec.ts` covers the statement shapes against a stubbed
 * Sequelize, and `mfa.e2e-spec.ts` exercises the whole thing against the real Postgres instance.
 * All three are required; none substitutes for another.
 *
 * Rows are stored mutably and handed out as copies, exactly as the sibling fakes do, so a service
 * that forgets to write a change back cannot appear to work because it mutated the store's own
 * object in place.
 */
import type {
  MfaStore,
  MfaUserRow,
  RecoveryCodeOutcome,
} from '@/modules/auth/services/mfa.repository';
import type { AuthTransaction } from '@/modules/auth/services/credential.repository';

interface StoredCode {
  userId: number;
  codeHash: string;
  usedAt: Date | null;
}

export class FakeMfaStore implements MfaStore {
  readonly users: MfaUserRow[] = [];
  readonly codes: StoredCode[] = [];

  /** Users treated as soft-deleted — `findUserForMfa` and `isMfaEnabled` both report nothing. */
  readonly deletedUserIds = new Set<number>();

  private nextUserId = 1;

  seedUser(overrides: Partial<MfaUserRow> = {}): MfaUserRow {
    const id = overrides.id ?? this.nextUserId;
    if (id >= this.nextUserId) this.nextUserId = id + 1;

    const user: MfaUserRow = {
      id,
      email: `super${id}@example.invalid`,
      displayName: 'Seeded Super Admin',
      role: 'super_admin',
      status: 'active',
      countryId: null,
      tenantId: null,
      merchantId: null,
      mustChangePassword: false,
      mfaEnabled: false,
      secretEnc: null,
      ...overrides,
    };
    this.users.push(user);
    return user;
  }

  /** The live row — assert against this, never against a copy handed out by a method. */
  userFor(id: number): MfaUserRow {
    const user = this.users.find((candidate) => candidate.id === id);
    if (user === undefined) throw new Error(`FakeMfaStore has no user ${id}`);
    return user;
  }

  codesFor(userId: number): StoredCode[] {
    return this.codes.filter((code) => code.userId === userId);
  }

  async findUserForMfa(userId: number, _tx?: AuthTransaction): Promise<MfaUserRow | null> {
    if (this.deletedUserIds.has(userId)) return null;
    const user = this.users.find((candidate) => candidate.id === userId);
    return user === undefined ? null : { ...user };
  }

  async isMfaEnabled(userId: number): Promise<boolean | null> {
    if (this.deletedUserIds.has(userId)) return null;
    const user = this.users.find((candidate) => candidate.id === userId);
    return user === undefined ? null : user.mfaEnabled;
  }

  async storeSecret(userId: number, secretEnc: string, _tx?: AuthTransaction): Promise<void> {
    this.replaceUser(userId, { secretEnc });
  }

  async enableMfa(userId: number, _tx?: AuthTransaction): Promise<void> {
    this.replaceUser(userId, { mfaEnabled: true });
  }

  async clearMfa(userId: number, _tx?: AuthTransaction): Promise<void> {
    this.replaceUser(userId, { mfaEnabled: false, secretEnc: null });
  }

  async insertRecoveryCodes(
    userId: number,
    codeHashes: readonly string[],
    _tx?: AuthTransaction,
  ): Promise<void> {
    for (const codeHash of codeHashes) {
      this.codes.push({ userId, codeHash, usedAt: null });
    }
  }

  async invalidateRecoveryCodes(userId: number, at: Date, _tx?: AuthTransaction): Promise<number> {
    let invalidated = 0;
    for (const code of this.codes) {
      if (code.userId !== userId || code.usedAt !== null) continue;
      code.usedAt = at;
      invalidated += 1;
    }
    return invalidated;
  }

  async consumeRecoveryCode(
    userId: number,
    codeHash: string,
    at: Date,
    _tx?: AuthTransaction,
  ): Promise<RecoveryCodeOutcome> {
    const match = this.codes.find((code) => code.userId === userId && code.codeHash === codeHash);
    if (match === undefined) return 'unknown';
    if (match.usedAt !== null) return 'already_used';

    match.usedAt = at;
    return 'consumed';
  }

  async countUnusedRecoveryCodes(userId: number, _tx?: AuthTransaction): Promise<number> {
    return this.codes.filter((code) => code.userId === userId && code.usedAt === null).length;
  }

  private replaceUser(userId: number, patch: Partial<MfaUserRow>): void {
    const index = this.users.findIndex((candidate) => candidate.id === userId);
    if (index === -1) return;
    this.users[index] = { ...this.users[index], ...patch };
  }
}
