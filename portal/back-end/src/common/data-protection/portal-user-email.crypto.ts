/**
 * T-056 — the one place that applies the `reward_portal.portal_users.email` at-rest policy to
 * code that does **not** go through Sequelize.
 *
 * ### Why this file has to exist at all
 *
 * `model-encryption.hooks.ts` (T-017) already encrypts, decrypts and blind-indexes every policy
 * column automatically — but only for callers that load and save through a Sequelize *model*.
 * The authentication path deliberately does not: `credential.repository.ts`, `session.repository.ts`
 * and `mfa.repository.ts` all use raw, parameterised SQL, for reasons each of those files argues at
 * length (T-013's `no-raw-model-access` rule bans model statics there, and the login lookup must be
 * a single query for the timing reason `credential.repository.ts` documents at line 89). Raw SQL
 * gets none of Sequelize's hooks, so those queries would read a `v1.…` envelope and hand it to the
 * caller as though it were an address.
 *
 * The alternative to this file is five copies of "build the AAD, encrypt, compute the index" spread
 * across three repositories and a CLI. Each copy is a chance to build the AAD differently, and an
 * AAD that differs by one character does not fail loudly — it fails as a decryption error on the
 * login path, at 3am, for one user.
 *
 * ### The AAD must be built the same way the hooks build it, including the flag
 *
 * §4 binds the record's identity into the ciphertext as additional authenticated data, so a
 * ciphertext lifted out of row A and pasted into row B fails its tag check. `bindRecordIdAsAAD`
 * (§10, `config/data-protection.json`) can switch that binding off — a documented security
 * downgrade the hooks honour in their own `aadFor()`.
 *
 * This class honours the identical flag, and that is not optional bookkeeping: if the hooks wrote a
 * row with an unbound AAD and this class tried to read it with a bound one, every login for that
 * row would fail to decrypt. The two must agree, so the flag is a constructor argument rather than
 * a hardcoded `true` — see `auth.module.ts`, which feeds it from the same config factory the
 * data-protection module uses.
 *
 * ### Why it is not provided by `DataProtectionModule`
 *
 * It cannot be. `DataProtectionModule` imports `SecurityModule`, which imports `AuthModule` — so
 * `AuthModule` importing `DataProtectionModule` back would be a DI cycle needing `forwardRef`.
 * The class therefore lives here (the correct layer — it applies an at-rest policy) but is
 * *registered* by its consumers, which already import `CryptoModule` and get both services from it.
 * The plain function import of `dataProtectionConfigFactory` used to build it is a TypeScript
 * import, not a Nest module import, and creates no cycle.
 */
import {
  BlindIndexService,
  FieldCryptoService,
  looksLikeCiphertext,
  normaliserForField,
} from '@/common/crypto';
import { PROVISIONAL_PK } from './model-encryption.hooks';
import { UNDECRYPTABLE_SENTINEL } from './data-protection.constants';

/** Schema-qualified table name — the first half of every AAD this class builds. */
export const PORTAL_USERS_TABLE = 'reward_portal.portal_users';

/** The policy row this class implements. Also the key `normaliserForField` is registered under. */
export const PORTAL_USERS_EMAIL_POLICY_KEY = `${PORTAL_USERS_TABLE}.email`;

/**
 * Applies the `portal_users.email` at-rest policy on the raw-SQL paths.
 *
 * Not `@Injectable()`: it is registered through an explicit `useFactory` (see the file header),
 * which needs no decorator and keeps the flag visible at the registration site.
 */
export class PortalUserEmailCrypto {
  constructor(
    private readonly fieldCrypto: FieldCryptoService,
    private readonly blindIndex: BlindIndexService,
    /** From `config.atRest.bindRecordIdAsAAD`. Must match what the hooks were given. */
    private readonly bindRecordIdAsAAD: boolean = true,
  ) {}

  /**
   * The deterministic lookup key for an address, normalised exactly as the hooks normalise it.
   *
   * `normaliserForField` is used rather than a literal `'email'` so that this class and the hooks
   * resolve the rule from the same registry: if T-016's field registry ever changes which rule
   * `portal_users.email` uses, both move together or neither does. Hand-rolling `trim().toLowerCase()`
   * here would silently keep the old rule and produce indexes that never match the stored ones.
   */
  blindIndexFor(email: string): string {
    return this.blindIndex.compute(email, normaliserForField(PORTAL_USERS_EMAIL_POLICY_KEY));
  }

  /**
   * The AAD for a row whose primary key is known, honouring `bindRecordIdAsAAD`.
   *
   * Deliberately identical in shape to `model-encryption.hooks.ts`'s private `aadFor()`. The two
   * are separate functions because neither module may import the other's internals, and they are
   * covered by a test that asserts a value encrypted by one decrypts under the other.
   */
  private aadFor(primaryKey: string | number): string {
    return this.bindRecordIdAsAAD
      ? FieldCryptoService.aadFor(PORTAL_USERS_TABLE, primaryKey)
      : FieldCryptoService.aadFor(PORTAL_USERS_TABLE, 'unbound');
  }

  /** Ciphertext bound to an existing row. */
  encryptForRow(userId: number, email: string): string {
    return this.fieldCrypto.encrypt(email, { aad: this.aadFor(userId) });
  }

  /**
   * Ciphertext for a row that does not have its identity column yet — the INSERT case.
   *
   * `portal_users.id` is `int generated always as identity`, so there is no id to bind until
   * Postgres has run the INSERT. This writes under the same `PROVISIONAL_PK` placeholder the hooks
   * use, and the caller **must** follow it with {@link rebindToRow} inside the same transaction.
   * Importing `PROVISIONAL_PK` rather than redeclaring `'#new'` is what stops the two schemes
   * drifting into mutual unreadability.
   *
   * When record binding is switched off the AAD does not depend on the id at all, so the value
   * written here is already final and the re-bind is a no-op — {@link rebindToRow} detects that.
   */
  encryptForNewRow(email: string): string {
    return this.fieldCrypto.encrypt(email, { aad: this.aadFor(PROVISIONAL_PK) });
  }

  /**
   * Re-encrypts a provisional ciphertext under the real primary key.
   *
   * Returns `null` when nothing needs rewriting — either because record binding is off (the AAD
   * never referenced the id) or because the value is not one of our envelopes. A `null` return
   * means "no UPDATE required", which lets the caller skip a statement rather than write a value
   * identical to the one already there.
   */
  rebindToRow(userId: number, provisionalCiphertext: string): string | null {
    if (!this.bindRecordIdAsAAD) return null;
    if (!looksLikeCiphertext(provisionalCiphertext)) return null;

    const plaintext = this.fieldCrypto.decrypt(provisionalCiphertext, {
      aad: this.aadFor(PROVISIONAL_PK),
    });
    return this.fieldCrypto.encrypt(plaintext, { aad: this.aadFor(userId) });
  }

  /**
   * Decrypts a value read by raw SQL, tolerating both of the two things it can legitimately be.
   *
   * **A value that is not an envelope is returned unchanged.** That is not a soft failure: it is
   * the only correct reading of a plaintext row, which exists in exactly one situation this system
   * genuinely produces — a row written before `T056_001` ran, on a database that has not been
   * migrated yet. Treating it as an error would take the portal down during a deploy window; the
   * migration backfills those rows, after which the branch is dead in production.
   *
   * **A decryption failure returns {@link UNDECRYPTABLE_SENTINEL} rather than throwing**, matching
   * `model-encryption.hooks.ts`'s stated rule that one bad row must not deny the whole request
   * (implementation note 3, TC-5). Applied here it means a user whose email ciphertext is damaged
   * can still *authenticate* — their password check is entirely independent of this field — instead
   * of being locked out by a display value. The alternative, throwing, converts a cosmetic data
   * problem into a total account lockout with a 500.
   */
  decryptForRow(userId: number, stored: string): string;
  decryptForRow(userId: number, stored: string | null): string | null;
  /**
   * The overloads above are not decoration. `portal_users.email` is `NOT NULL`, so every caller in
   * this codebase passes a `string` and none of them should have to write `?? ''` against a `null`
   * the database cannot produce — a fallback that can never run is an untestable branch, and the
   * authentication paths are held to 100% branch coverage (AGENT-PROTOCOL §4). The nullable form
   * stays for the migration's backfill, which reads columns generically.
   */
  decryptForRow(userId: number, stored: string | null): string | null {
    if (stored === null) return null;
    if (!looksLikeCiphertext(stored)) return stored;

    try {
      return this.fieldCrypto.decrypt(stored, { aad: this.aadFor(userId) });
    } catch {
      // Deliberately not logged here: this class has no logger, and the ciphertext must never
      // reach one. The sentinel is itself the signal, and it is visible in the response.
      return UNDECRYPTABLE_SENTINEL;
    }
  }
}
