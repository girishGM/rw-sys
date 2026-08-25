/**
 * T-010 — the password policy (Implementation notes §3–4, 02-SECURITY.md §2).
 *
 * This service answers exactly one question — *may this string become a password for this
 * account?* — and it answers it the same way everywhere: at bootstrap, at first login, at a
 * self-service change and at an admin-driven reset. It holds no state and touches no
 * database; the caller supplies the account's stored hashes, because the caller is the only
 * one with a legitimate reason to have loaded them.
 *
 * ### Why the violations are returned rather than thrown
 *
 * `validate()` returns *every* rule the password breaks, not the first. A form that reveals
 * one failure at a time trains users into `Password1!` → `Password12!` → `Password123!`,
 * which is precisely the shape this policy exists to reject. The caller turns the list into
 * a {@link PasswordPolicyError}; the codes are stable machine identifiers that T-014's
 * `system_messages` catalogue localises, never user-facing sentences.
 *
 * ### The asymmetry with `CredentialService`, stated explicitly
 *
 * Being specific here is safe and being specific there is not, and the difference is worth
 * understanding before anyone "makes them consistent". A password *change* is performed by
 * someone who has already proved who they are, about their own account — telling them
 * "you've used this password before" discloses nothing they did not already know. A *login*
 * is performed by an unauthenticated stranger about an account that may not be theirs, so
 * every distinguishable answer is a user-enumeration oracle. Same system, opposite rules,
 * for a reason.
 */
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import {
  COMMON_PASSWORDS,
  LEET_SUBSTITUTIONS,
  PASSWORD_EMAIL_LOCAL_PART_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_CHARACTER_CLASSES,
  PASSWORD_MIN_LENGTH,
} from '../auth.constants';

/**
 * Stable machine codes for the rules in Implementation notes §3. Deliberately *not* a
 * message: T-014 owns the wording, per locale, in `system_messages`.
 */
export type PasswordPolicyViolation =
  | 'too_short'
  | 'too_long'
  | 'insufficient_character_classes'
  | 'common_password'
  | 'contains_email'
  | 'password_reused';

/** Everything the policy needs about the account the password is being set for. */
export interface PasswordPolicyContext {
  /** The account's email, for the local-part rule. Omitted where there isn't one yet. */
  readonly email?: string | null;
  /** The hash currently in `portal_user_credentials.password_hash`, if any. */
  readonly currentHash?: string | null;
  /** `portal_user_credentials.previous_hashes`, newest first, if any. */
  readonly previousHashes?: readonly string[] | null;
}

/** The four character classes of Implementation notes §3. */
interface CharacterClasses {
  readonly lower: boolean;
  readonly upper: boolean;
  readonly digit: boolean;
  readonly symbol: boolean;
}

@Injectable()
export class PasswordPolicyService {
  /**
   * The rules that need nothing but the password itself and the account's email.
   * Synchronous and side-effect-free, so a caller can run it before doing any I/O — and so
   * the expensive Argon2 reuse check in {@link validate} is only reached by a password that
   * has already passed everything cheap.
   */
  validateSync(password: string, context: PasswordPolicyContext = {}): PasswordPolicyViolation[] {
    const violations: PasswordPolicyViolation[] = [];

    if (password.length < PASSWORD_MIN_LENGTH) violations.push('too_short');
    // Not a usability limit — see PASSWORD_MAX_LENGTH's comment. An unbounded password is an
    // unbounded amount of pre-authentication work for the server.
    if (password.length > PASSWORD_MAX_LENGTH) violations.push('too_long');

    if (countClasses(characterClasses(password)) < PASSWORD_MIN_CHARACTER_CLASSES) {
      violations.push('insufficient_character_classes');
    }

    if (isCommonPassword(password)) violations.push('common_password');

    if (context.email != null && containsEmail(password, context.email)) {
      violations.push('contains_email');
    }

    return violations;
  }

  /**
   * The full policy: {@link validateSync} plus the history rule (Implementation notes §4).
   *
   * The reuse check runs `argon2.verify` against the current hash and each stored previous
   * hash — never a string comparison, because every hash carries its own random salt and two
   * hashes of the same password are different strings. That is also why history can only be
   * checked one candidate at a time, and why this method is `async` while `validateSync` is
   * not: it costs one full Argon2 verification per stored hash.
   *
   * The verifications run sequentially rather than through `Promise.all`. Each one allocates
   * `memoryCost` (19 MiB), so six in parallel is ~114 MiB of simultaneous allocation per
   * in-flight change-password request — a cheap way to make the process an easy memory
   * target. Sequentially the whole check costs well under a second on an authenticated,
   * rate-limited, human-driven endpoint, which is the right trade.
   */
  async validate(
    password: string,
    context: PasswordPolicyContext = {},
  ): Promise<PasswordPolicyViolation[]> {
    const violations = this.validateSync(password, context);

    if (await this.isReused(password, context)) violations.push('password_reused');

    return violations;
  }

  /**
   * True when `password` matches the account's current hash or any hash still in its history
   * window.
   *
   * The current hash is included on purpose: "you may not reuse your last 5 passwords" is
   * meaningless if you may set your password to the one you are already using. With a
   * history window of 5 stored hashes plus the live one, the effective window is 6 — see
   * `PASSWORD_HISTORY_SIZE`.
   */
  async isReused(password: string, context: PasswordPolicyContext = {}): Promise<boolean> {
    const candidates = [context.currentHash, ...(context.previousHashes ?? [])];

    for (const hash of candidates) {
      if (typeof hash !== 'string' || hash.length === 0) continue;
      if (await verifyQuietly(hash, password)) return true;
    }

    return false;
  }
}

// --- rule implementations --------------------------------------------------------------

/**
 * `argon2.verify` throws on a digest it cannot parse. Here that means a corrupt or
 * foreign-format entry in `previous_hashes`, which must not be able to crash a
 * change-password request — and must not be treated as a match either, since "we could not
 * check this one" is not "this one matched". Fails towards *allowing* the password, which is
 * the safe direction for a history check: the worst case is a user reusing a password whose
 * stored hash was already unreadable.
 */
async function verifyQuietly(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * Unicode-aware, not ASCII-aware. `\p{Ll}`/`\p{Lu}`/`\p{Nd}` mean "any lowercase letter",
 * "any uppercase letter", "any decimal digit" in any script, so a Cyrillic or Greek
 * passphrase is measured by the same rule an ASCII one is instead of being classified as
 * pure symbols and rejected. "Symbol" is then defined by exclusion — anything that is not
 * one of the other three — which correctly counts spaces, punctuation, emoji and CJK
 * ideographs rather than needing a list of every glyph in Unicode.
 */
function characterClasses(password: string): CharacterClasses {
  return {
    lower: /\p{Ll}/u.test(password),
    upper: /\p{Lu}/u.test(password),
    digit: /\p{Nd}/u.test(password),
    symbol: /[^\p{Ll}\p{Lu}\p{Nd}]/u.test(password),
  };
}

function countClasses(classes: CharacterClasses): number {
  return Object.values(classes).filter(Boolean).length;
}

/**
 * Folds the decorations people add to a common word, so the list does not need an entry for
 * every one of them — see `COMMON_PASSWORDS`.
 *
 * Five candidate forms are tested, because stripping and folding do not commute:
 * `!p@ssw0rd!` needs stripping *after* folding (the `!` becomes an `i` and would otherwise
 * be kept as a letter), while `password123!` needs stripping before folding is even
 * relevant. Testing both orders costs five set lookups and removes a whole class of
 * near-misses.
 */
function isCommonPassword(password: string): boolean {
  const lowered = password.normalize('NFKC').toLowerCase();
  const stripped = stripNonLetterEdges(lowered);
  const folded = foldLeet(lowered);

  const candidates = [lowered, stripped, folded, foldLeet(stripped), stripNonLetterEdges(folded)];

  return candidates.some((candidate) => COMMON_PASSWORDS.has(candidate));
}

/** Drops leading and trailing non-letters: `!password123` and `password` are one word. */
function stripNonLetterEdges(value: string): string {
  return value.replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}]+$/u, '');
}

function foldLeet(value: string): string {
  let folded = '';
  for (const char of value) folded += LEET_SUBSTITUTIONS[char] ?? char;
  return folded;
}

/**
 * Implementation notes §3, "not equal to the email local-part" — implemented as *contains*,
 * not *equals*, because `gm@x.comAAA1!` (TC-9) is exactly the evasion an equality check
 * misses and is no stronger than the address it decorates.
 *
 * The full address always counts; the bare local part only counts once it is long enough to
 * be meaningful, per `PASSWORD_EMAIL_LOCAL_PART_MIN_LENGTH` — rejecting every passphrase
 * that happens to contain `gm` or `ops` would push users towards worse choices for no
 * security gain.
 */
function containsEmail(password: string, email: string): boolean {
  const haystack = password.toLowerCase();
  const address = email.trim().toLowerCase();

  if (address.length > 0 && haystack.includes(address)) return true;

  const localPart = address.split('@')[0];
  return localPart.length >= PASSWORD_EMAIL_LOCAL_PART_MIN_LENGTH && haystack.includes(localPart);
}
