/**
 * T-050 — a minimal RFC 6238 TOTP code generator, so the suite can complete the mandatory
 * `super_admin` MFA challenge (T-055) without a human ever opening an authenticator app.
 *
 * Deliberately re-implemented rather than pulled from npm, for the same reason
 * `back-end/src/modules/auth/services/totp.ts`'s own header gives: it is thirty lines of
 * arithmetic specified completely by RFC 4226 §5.3 / RFC 6238 §4.2, and re-implementing it here
 * means this suite exercises the exact same algorithm the server does, with no shared code
 * between the two — so a code this file mints and the server's own `verifyTotpCode` accepting it
 * is a genuine, independent confirmation that T-055 shipped a spec-compliant implementation, not
 * an artifact of both sides importing the same buggy library.
 *
 * Parameters (algorithm sha1, 6 digits, 30-second step) match
 * `back-end/src/modules/auth/mfa.constants.ts` exactly — those values are public (T-055's own
 * header: "published in every otpauth:// URI the portal hands out"), so hard-coding them here is
 * not a secret, just an assumption this file states plainly instead of parameterising for no
 * caller that will ever supply anything else.
 */
import { createHmac } from 'node:crypto';

const DIGITS = 6;
const PERIOD_SECONDS = 30;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 §6 base32 decode. Tolerates lowercase and stray padding, same as the server's own
 * `decodeBase32` — a seed pasted from a QR-code payload commonly carries both. */
function decodeBase32(encoded: string): Buffer {
  const normalised = encoded.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const character of normalised) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error(`totp.ts: '${character}' is not a base32 character`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotpCode(secret: Buffer, counter: number): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(counterBytes).digest();

  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The 6-digit code a correctly-configured authenticator would show `at` (defaults to now). */
export function totpCodeAt(secretBase32: string, at: Date = new Date()): string {
  const secret = decodeBase32(secretBase32);
  const step = Math.floor(at.getTime() / 1000 / PERIOD_SECONDS);
  return hotpCode(secret, step);
}
