/**
 * T-024 — a client-side mirror of the password composition rules `PasswordPolicyService`
 * (T-010, `back-end/src/modules/auth/services/password-policy.service.ts`) enforces, used to
 * give a user real-time, pre-submit feedback (T-024 implementation note 3: "a strength meter
 * driven by the same shared Zod policy as the server, so the UI cannot promise a password the
 * API rejects").
 *
 * ### Not actually the *same* shared schema, and why
 *
 * The literal reading of implementation note 3 is a schema in `packages/shared` both
 * workspaces import. `packages/shared/**` is not in T-024's file scope (AGENT-PROTOCOL R9), so
 * this module is a hand-written mirror instead — flagged as a deviation in the T-024 completion
 * report, with the follow-up spelled out there.
 *
 * ### What this deliberately does NOT check, and why
 *
 * Three of the server's six rules cannot be honestly evaluated on the client and are not
 * attempted here:
 *
 *  - `common_password` — the back end's list (`COMMON_PASSWORDS`, `auth.constants.ts`) is not
 *    exported anywhere this workspace can import it from. Hand-copying a large, security-
 *    relevant word list into a second file that must be kept in sync by inspection would be
 *    worse than not having it: a silent drift would create a false sense of client-side safety.
 *  - `contains_email` — `bootstrapUserSchema` (`packages/shared/bootstrap.schema.ts`)
 *    deliberately omits `email` from `/me/bootstrap`, and both screens that set a new password
 *    (forced change, reset-by-token) run before any authenticated call has necessarily
 *    succeeded. There is no email address on the client to check against.
 *  - `password_reused` — needs the account's stored hash history, which never leaves the
 *    server.
 *
 * All three still produce a clear, rendered error when the server's response carries them
 * ({@link describeViolation} covers all six codes) — they just cannot be pre-empted before the
 * round trip. The two rules that *can* be checked client-side (length, character-class count)
 * are the ones a real user is overwhelmingly likely to trip, so the meter is still meaningfully
 * predictive despite the gap.
 */
import { z } from 'zod';

/** Mirrors `PASSWORD_MIN_LENGTH` (`back-end/src/modules/auth/auth.constants.ts`). */
export const PASSWORD_MIN_LENGTH = 12;
/** Mirrors `PASSWORD_MAX_LENGTH`. */
export const PASSWORD_MAX_LENGTH = 256;
/** Mirrors `PASSWORD_MIN_CHARACTER_CLASSES`. */
export const PASSWORD_MIN_CHARACTER_CLASSES = 3;

/** Mirrors `PasswordPolicyViolation` (`password-policy.service.ts`) — every code either side of
 * the wire can produce, not just the subset this module can check client-side. */
export type PasswordPolicyViolation =
  | 'too_short'
  | 'too_long'
  | 'insufficient_character_classes'
  | 'common_password'
  | 'contains_email'
  | 'password_reused';

interface CharacterClasses {
  readonly lower: boolean;
  readonly upper: boolean;
  readonly digit: boolean;
  readonly symbol: boolean;
}

/** Identical approach to the server's own `characterClasses` — Unicode-aware, "symbol" defined
 * by exclusion of the other three. */
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

export function passwordMeetsLengthRequirement(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}

export function passwordHasEnoughCharacterClasses(password: string): boolean {
  return countClasses(characterClasses(password)) >= PASSWORD_MIN_CHARACTER_CLASSES;
}

/** Copy for every violation code, including the three this module cannot pre-check (see file
 * banner) — those still need a message here for when the *server's* response carries them. */
export const PASSWORD_POLICY_VIOLATION_MESSAGES: Readonly<Record<PasswordPolicyViolation, string>> =
  Object.freeze({
    too_short: `Must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    too_long: `Must be no more than ${PASSWORD_MAX_LENGTH} characters.`,
    insufficient_character_classes: `Use at least ${PASSWORD_MIN_CHARACTER_CLASSES} of: lowercase letters, uppercase letters, numbers, symbols.`,
    common_password: 'This password is too common. Choose something less predictable.',
    contains_email: 'Your password must not contain your email address.',
    password_reused: "You've used this password recently. Choose a different one.",
  });

/** Renders any violation code the server sends, even one this module never checks itself. */
export function describeViolation(code: string): string {
  return (
    PASSWORD_POLICY_VIOLATION_MESSAGES[code as PasswordPolicyViolation] ??
    'This password is not allowed.'
  );
}

/**
 * The `newPassword` field schema every "set a new password" form (change, reset) uses —
 * length and character-class rules only, per the file banner. Composed with `.min`/`.max`
 * first so their messages win over the character-class refinement for a too-short password,
 * matching how a user actually reads the rules (length first).
 */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, PASSWORD_POLICY_VIOLATION_MESSAGES.too_short)
  .max(PASSWORD_MAX_LENGTH, PASSWORD_POLICY_VIOLATION_MESSAGES.too_long)
  .refine(passwordHasEnoughCharacterClasses, {
    message: PASSWORD_POLICY_VIOLATION_MESSAGES.insufficient_character_classes,
  });
