/**
 * T-055 — RFC 4226 (HOTP) and RFC 6238 (TOTP), plus the RFC 4648 base32 an authenticator app
 * expects a seed in.
 *
 * ---
 *
 * ### Why this is implemented here rather than pulled from npm
 *
 * The same argument `token.service.ts` makes for JWS, and it applies more strongly here. No TOTP
 * library is a workspace dependency and this environment cannot add one; what such a library
 * would contribute is `HMAC-SHA1 → dynamic truncation → modulo`, thirty lines of arithmetic
 * specified completely in RFC 4226 §5.3 and verifiable against the RFC's own published test
 * vectors, which `test/auth/totp.spec.ts` runs. Everything cryptographic is Node's `crypto`.
 *
 * What a library would *not* fix is the part that actually goes wrong in TOTP deployments, and
 * this file is written to make each of those unrepresentable rather than merely handled:
 *
 *  - **A verification window that quietly widens.** {@link verifyTotpCode} takes its window from
 *    `TOTP_SKEW_STEPS` and iterates a closed range; there is no "lenient" mode and no caller-
 *    supplied window that a future call site could pass `5` to.
 *  - **A non-constant-time comparison of the code.** `timingSafeEqual`, always, and every step in
 *    the window is compared even after one has matched — so neither *whether* a code matched nor
 *    *which* step it matched on is observable in the response time.
 *  - **A secret that is a string.** Seeds are `Buffer`s here. A base32 string that has been
 *    round-tripped through `String.prototype.toUpperCase` and a stray `=` is the classic source
 *    of "it worked on my phone but not on theirs".
 *
 * ### What this file does not do
 *
 * It reads no database, holds no state and knows nothing about users. In particular it does
 * **not** remember which codes have been used: replay of a code inside its own 90-second window
 * is discussed, and bounded, in `mfa.service.ts`.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_SECRET_BYTES,
  TOTP_SKEW_STEPS,
} from '../mfa.constants';

/** RFC 4648 §6, the base32 alphabet. Uppercase only; padding is never emitted. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A code is digits and nothing else. The *shape* of a code is public information. */
const DIGITS_ONLY = /^[0-9]+$/;

/** Raised for input that is not a seed at all. Never carries the value it rejected. */
export class TotpFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TotpFormatError';
    Error.captureStackTrace?.(this, TotpFormatError);
  }
}

/** A fresh 160-bit seed from the CSPRNG (`TOTP_SECRET_BYTES`, RFC 4226 §4). */
export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/**
 * Base32 without padding, which is what every authenticator app accepts in an `otpauth://` URI.
 *
 * Padding is omitted rather than stripped afterwards: `=` is legal in RFC 4648 but is percent-
 * encoded inside a URI query string, and several apps fail to decode it. A 20-byte seed encodes
 * to 32 characters with no padding anyway.
 */
export function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * The inverse. Tolerates lowercase, spaces and `=` padding — all three appear when a user types
 * a seed in by hand — and rejects anything else rather than skipping it, because a character
 * silently dropped from a seed produces a different key and an unexplainable "wrong code".
 */
export function decodeBase32(encoded: string): Buffer {
  const normalised = encoded.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (normalised.length === 0) throw new TotpFormatError('base32 seed is empty');

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const character of normalised) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new TotpFormatError('base32 seed contains a non-alphabet character');

    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

/**
 * HOTP (RFC 4226 §5.3): HMAC, dynamic truncation, modulo, zero-padded to `digits`.
 *
 * The counter is written as an 8-byte big-endian integer through `BigInt`, not through two
 * 32-bit halves: the naive `writeUInt32BE(counter / 2**32)` form is correct for every counter
 * anyone will test with and wrong for none they will — which is exactly the kind of bug that
 * surfaces years later, on one device, as "MFA stopped working".
 */
export function hotpCode(secret: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new TotpFormatError('HOTP counter must be a non-negative safe integer');
  }
  if (secret.length === 0) throw new TotpFormatError('HOTP secret is empty');

  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(TOTP_ALGORITHM, secret).update(counterBytes).digest();

  // RFC 4226 §5.3 dynamic truncation: the low nibble of the last byte selects the offset, and
  // the top bit of the selected word is masked off so the result is a positive 31-bit integer.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The time step index for an instant — `floor(unix seconds / period)` (RFC 6238 §4.2). */
export function timeStepAt(now: Date, periodSeconds: number = TOTP_PERIOD_SECONDS): number {
  return Math.floor(now.getTime() / 1000 / periodSeconds);
}

/** The code a correctly-configured authenticator shows at `now`. */
export function totpCodeAt(
  secret: Buffer,
  now: Date,
  digits: number = TOTP_DIGITS,
  periodSeconds: number = TOTP_PERIOD_SECONDS,
): string {
  return hotpCode(secret, timeStepAt(now, periodSeconds), digits);
}

/**
 * Verifies a presented code against the current step and `TOTP_SKEW_STEPS` either side of it.
 *
 * Two properties worth stating, because both are load-bearing and neither is visible from the
 * signature:
 *
 *  - **The window is fixed.** It comes from the module constant, not from a parameter. A caller
 *    cannot widen it, and the one place it could ever change is `mfa.constants.ts`, next to the
 *    paragraph explaining what widening it costs.
 *  - **Every step is evaluated.** The loop does not `return` on the first match; it accumulates.
 *    An early return would make the response time depend on which step matched, which leaks the
 *    victim's clock offset — small, but free to avoid.
 *
 * Returns `false` (never throws) for a code of the wrong length, wrong shape or wrong value: to
 * this function they are all "not the right code", and a caller that could distinguish them
 * would be able to tell the client which, on an unauthenticated route.
 */
export function verifyTotpCode(secret: Buffer, presented: string, now: Date): boolean {
  const candidate = presented.replace(/[\s-]/g, '');
  if (candidate.length !== TOTP_DIGITS) return false;
  if (!DIGITS_ONLY.test(candidate)) return false;
  if (secret.length === 0) return false;

  const currentStep = timeStepAt(now);
  let matched = false;

  for (let offset = -TOTP_SKEW_STEPS; offset <= TOTP_SKEW_STEPS; offset += 1) {
    const step = currentStep + offset;
    // Only reachable for a clock set before 1970; guarded so `hotpCode` cannot throw here.
    if (step < 0) continue;
    matched = constantTimeEquals(hotpCode(secret, step), candidate) || matched;
  }

  return matched;
}

/**
 * The provisioning URI an authenticator app consumes (the "key URI format" every implementation
 * follows).
 *
 * Every parameter is stated explicitly, including the ones whose values are the app's defaults.
 * An omitted `algorithm`/`digits`/`period` is *usually* interpreted as SHA-1/6/30 — "usually" is
 * not a property to build an authentication factor on, and the cost of being explicit is zero.
 *
 * The label is `issuer:account`, and the `issuer` parameter repeats it, which is what makes the
 * entry render as "Reward Portal (someone@example.com)" rather than as a bare address in a list
 * of eleven other bare addresses.
 */
export function buildOtpauthUri(input: {
  issuer: string;
  account: string;
  secretBase32: string;
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const query = [
    `secret=${input.secretBase32}`,
    `issuer=${encodeURIComponent(input.issuer)}`,
    `algorithm=${TOTP_ALGORITHM.toUpperCase()}`,
    `digits=${TOTP_DIGITS}`,
    `period=${TOTP_PERIOD_SECONDS}`,
  ].join('&');

  return `otpauth://totp/${label}?${query}`;
}

/**
 * Length-checked `timingSafeEqual` over two ASCII strings, exactly as `csrf.guard.ts` does and
 * for the same reason: `timingSafeEqual` throws a `RangeError` on unequal lengths, and a code's
 * length is a public property of this system.
 *
 * Exported for its own test. The length branch is unreachable through {@link verifyTotpCode} —
 * that function has already forced the candidate to `TOTP_DIGITS` characters, and `hotpCode`
 * always produces exactly that many — which is precisely why it is asserted directly, on the same
 * argument `token.service.ts` makes about `assertRsaKey`: an unreachable guard that has never
 * been executed is an unreachable guard nobody knows is correct, and "unreachable" is a claim
 * about today's callers rather than a property of this function.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
