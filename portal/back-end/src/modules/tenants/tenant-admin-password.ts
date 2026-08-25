/**
 * T-034 implementation note 5 / BACKLOG.md B-01 — server-generated, one-time-shown credential
 * for a newly onboarded Tenant Admin.
 *
 * A deliberate, near-identical copy of `countries/country-admin-password.ts` (T-030's own
 * narrow, self-contained instance of the pattern T-046 later generalises for `/users`). T-034
 * cannot depend on T-046 either — `Depends on` is `Wave 2, T-030, T-006`, and T-046 depends on
 * T-035, which depends on this task — so the second link in the delegation chain needs its own
 * copy of the same "generate, return once, never store the plaintext" logic. T-046 is expected
 * to fold both call sites into its own generic `/users` mechanism once it lands; noted for the
 * reviewer, exactly as `country-admin-password.ts`'s own header notes for T-030.
 */
import { randomInt } from 'node:crypto';

/** No `O`, `0`, `l`, `1`, `I` — it is transcribed by a human. */
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+';
const FULL_ALPHABET = LOWER + UPPER + DIGITS + SYMBOLS;

/** One CSPRNG-drawn character from `alphabet`. */
function draw(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)];
}

/** Fisher–Yates, using the same CSPRNG as {@link draw} — no `Math.random` anywhere in this file. */
function shuffle(chars: string[]): string[] {
  const out = [...chars];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A 24-character password: one character from each of the four classes above (so composition
 * policies are satisfied by construction, not by chance), the rest drawn from the full
 * unambiguous alphabet, then shuffled so the guaranteed characters are not predictably placed.
 */
export function generateTemporaryPassword(length = 24): string {
  if (length < 4) {
    throw new Error('generateTemporaryPassword: length must be at least 4 (one per class).');
  }

  const guaranteed = [draw(LOWER), draw(UPPER), draw(DIGITS), draw(SYMBOLS)];
  const rest = Array.from({ length: length - guaranteed.length }, () => draw(FULL_ALPHABET));

  return shuffle([...guaranteed, ...rest]).join('');
}
