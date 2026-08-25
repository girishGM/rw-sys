/**
 * T-035 implementation note 4 (as revised — see `users.service.ts`'s own header) / BACKLOG.md
 * B-01 — server-generated, one-time-shown credential for a newly created user, and for an
 * admin-initiated reset.
 *
 * A deliberate, near-identical copy of `countries/country-admin-password.ts` and
 * `tenants/tenant-admin-password.ts` — the same "generate, return once, never store the
 * plaintext" logic those two files' own headers describe, and the same reason for the
 * duplication: T-046 (`Depends on: T-035`) is the task that generalises this into
 * `back-end/src/modules/users/services/temporary-password.service.ts`, with the additions its
 * own task file specifies (72-hour expiry, rate limiting, `temporary_password_issued` audit).
 * This module cannot depend on a task that depends on it, so it carries its own copy meanwhile,
 * exactly as `tenant-admin-password.ts`'s header notes for its own predecessor. Flagged for the
 * reviewer, as that file's header flags it too.
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
