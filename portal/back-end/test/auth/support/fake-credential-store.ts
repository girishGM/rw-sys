/**
 * T-010 unit-test support — an in-memory `CredentialStore`.
 *
 * **What this double is for.** The credential layer's security properties are decisions, not
 * SQL: which failure code is chosen, whether the counter advances, whether a lock is set and
 * for how long, and — above all — whether every path performs the same amount of
 * cryptographic work. Driving those from memory means every branch the 100% coverage bar
 * demands is reachable deterministically, and it means TC-4's timing comparison measures
 * Argon2 rather than the local network stack's mood.
 *
 * **What it is not for.** It is not evidence that the SQL in `credential.repository.ts` is
 * correct — it never sees that SQL. `credential.repository.spec.ts` covers the repository
 * against a stubbed Sequelize (statement shape, bound parameters, truncation, `inet`
 * sanitising), and T-011's `auth.e2e-spec.ts` exercises the whole thing against the real
 * database. All three are required; none substitutes for another.
 *
 * Rows are stored mutably and handed out as copies, so a service that forgets to write a
 * change back cannot appear to work because it mutated the store's own object in place.
 */
import type {
  AuthTransaction,
  AuthUserRow,
  AuthenticationRecord,
  CredentialRow,
  CredentialStore,
  LockStateUpdate,
  LoginAttemptInput,
  PasswordUpdate,
} from '@/modules/auth/services/credential.repository';

/** Mutable mirror of `CredentialRow`, which is readonly at the port boundary. */
interface StoredCredential {
  id: number;
  userId: number;
  passwordHash: string;
  passwordAlgo: string;
  previousHashes: string[] | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  passwordExpiresAt: Date | null;
}

export interface SeedUserOptions extends Partial<AuthUserRow> {
  readonly email: string;
}

export class FakeCredentialStore implements CredentialStore {
  readonly users: AuthUserRow[] = [];
  readonly credentials: StoredCredential[] = [];

  /** Every attempt written, in order — the assertion surface for TC-19. */
  readonly attempts: (LoginAttemptInput & { transactional: boolean })[] = [];

  /** Every lock-state write, in order, for asserting counter arithmetic. */
  readonly lockWrites: (LockStateUpdate & { credentialId: number })[] = [];

  /** Every password replacement, in order, for asserting history trimming. */
  readonly passwordWrites: (PasswordUpdate & { credentialId: number })[] = [];

  private nextUserId = 1;
  private nextCredentialId = 1;

  seedUser(options: SeedUserOptions): AuthUserRow {
    const user: AuthUserRow = {
      id: this.nextUserId++,
      displayName: 'Seeded User',
      role: 'maker',
      status: 'active',
      countryId: null,
      tenantId: null,
      merchantId: null,
      mustChangePassword: false,
      mfaEnabled: false,
      ...options,
    };
    this.users.push(user);
    return user;
  }

  seedCredential(userId: number, passwordHash: string, overrides: Partial<CredentialRow> = {}) {
    const credential: StoredCredential = {
      id: this.nextCredentialId++,
      userId,
      passwordHash,
      passwordAlgo: 'argon2id',
      previousHashes: null,
      failedAttempts: 0,
      lockedUntil: null,
      passwordExpiresAt: null,
      ...overrides,
    };
    this.credentials.push(credential);
    return credential;
  }

  /** Reads the live row — tests assert against this, not against a stale copy. */
  credentialFor(userId: number): StoredCredential {
    const credential = this.credentials.find((c) => c.userId === userId);
    if (credential === undefined)
      throw new Error(`FakeCredentialStore has no credential for ${userId}`);
    return credential;
  }

  async findAuthenticationRecordByEmail(email: string): Promise<AuthenticationRecord | null> {
    // Mirrors the repository's `lower(u.email) = :email` predicate.
    const normalised = email.trim().toLowerCase();
    const user = this.users.find((u) => u.email.trim().toLowerCase() === normalised);
    if (user === undefined) return null;

    const credential = this.credentials.find((c) => c.userId === user.id);
    return { user, credential: credential === undefined ? null : { ...credential } };
  }

  async findCredentialByUserId(userId: number): Promise<CredentialRow | null> {
    const credential = this.credentials.find((c) => c.userId === userId);
    return credential === undefined ? null : { ...credential };
  }

  async recordLoginAttempt(input: LoginAttemptInput, tx?: AuthTransaction): Promise<void> {
    this.attempts.push({ ...input, transactional: tx !== undefined });
  }

  async updateLockState(
    credentialId: number,
    update: LockStateUpdate,
    _tx?: AuthTransaction,
  ): Promise<void> {
    this.lockWrites.push({ credentialId, ...update });
    const credential = this.credentials.find((c) => c.id === credentialId);
    if (credential === undefined) return;
    credential.failedAttempts = update.failedAttempts;
    credential.lockedUntil = update.lockedUntil;
  }

  async replacePassword(
    credentialId: number,
    update: PasswordUpdate,
    _tx?: AuthTransaction,
  ): Promise<void> {
    this.passwordWrites.push({ credentialId, ...update });
    const credential = this.credentials.find((c) => c.id === credentialId);
    if (credential === undefined) return;
    credential.passwordHash = update.passwordHash;
    credential.passwordAlgo = update.passwordAlgo;
    credential.previousHashes = [...update.previousHashes];
  }

  async runInTransaction<T>(fn: (tx: AuthTransaction) => Promise<T>): Promise<T> {
    return fn({} as AuthTransaction);
  }
}
