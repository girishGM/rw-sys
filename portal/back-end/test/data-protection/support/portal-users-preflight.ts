/**
 * T-070 — the precondition `t056-backfill.e2e-spec.ts` actually needs before it may roll
 * `reward_portal.portal_users` backwards and forwards.
 *
 * ### What went wrong
 *
 * That suite drives `T056_001.up()`/`down()` as functions, and both operate on the **whole**
 * table — the migration hard-codes `reward_portal.portal_users` and there is no seam to point it
 * at a scratch copy. So the suite unavoidably takes every other row in the table along for the
 * ride, and it guarded that with:
 *
 * ```ts
 * expect(foreign).toBe(0);   // count of rows the suite did not create
 * ```
 *
 * The comment above that line states the real requirement precisely — *"it can only run when
 * every row in it is decryptable with the keys currently configured"* — but the code asserts
 * something far stronger and unrelated: that no other row exists **at all**. On a shared
 * development database that is unsatisfiable in practice. Three rows were present when this task
 * reproduced it (ids 3235, 3344 from manual UI-verification sessions on 2026-08-19, and 4657 from
 * a `t004-seeds-bootstrap` run on 2026-08-20), every one of them encrypted under the live
 * `dev_local_fld` key and therefore perfectly decryptable — i.e. all three satisfied the stated
 * precondition and all three failed the coded one.
 *
 * Deleting them was rejected as the remedy for a reason the evidence itself supplies: the defect
 * was filed naming two rows and a **third had appeared, from a different source, before anyone
 * looked at it**. A guard that a normal login re-breaks is not a guard, it is a scheduled
 * failure. What this module does instead is implement the precondition the suite's own comment
 * already describes.
 *
 * ### Why letting a foreign row round-trip is safe, and where the real line is
 *
 * `down()` decrypts each row and writes the plaintext back; `up()` re-encrypts it under whatever
 * `field` key is active and recomputes its blind index. For a row whose key material is reachable
 * that is lossless — the address is unchanged, only the envelope around it differs (and if the
 * row was written under a `rotating` kid, it comes back under the `active` one, which is a
 * re-key, not a loss). The e2e suite proves that rather than assuming it, by fingerprinting every
 * foreign row before the round trip and comparing afterwards.
 *
 * For a row whose key material is **gone** — the `T-067` residue class, an ephemeral suite key
 * whose `env:` variable died with the process that generated it — there is no safe move at all.
 * `T056_001.down()` refuses such a row on purpose ("rolling back would replace the address with a
 * placeholder and lose it"), and it is right to. That is the one case that must still stop the
 * suite, and it is the case {@link classifyForeignRow} isolates.
 *
 * The predicate is therefore the same one `test/support/encryption-keys.ts` argues for the key
 * table: reachability of the key material, not the mere existence of a row.
 *
 * ### Why the logic lives here and not inline in the spec
 *
 * A guard whose failure mode is "the whole table is left in the wrong shape" is worth testing on
 * its own, and it cannot be tested from inside the suite it guards — by the time that suite runs,
 * the interesting inputs (an unreachable kid) are exactly the ones you must not create in a
 * shared database. Extracting it makes both branches reachable from a unit test with no database
 * at all: see `portal-users-preflight.spec.ts`.
 */
import { looksLikeCiphertext, parseCiphertext } from '@/common/crypto';
import { UNDECRYPTABLE_SENTINEL } from '@/common/data-protection/data-protection.constants';

/** A row of `portal_users` as the preflight reads it: identity plus the protected column. */
export interface ForeignRow {
  id: number;
  email: string;
}

/**
 * The subset of `PortalUserEmailCrypto` this module needs.
 *
 * Structural rather than the concrete class so the unit test can supply a stub without a key
 * registry, a database or an environment — and so this file cannot accidentally start depending
 * on some other part of that class.
 */
export interface EmailCryptoLike {
  decryptForRow(userId: number, stored: string): string;
  blindIndexFor(email: string): string;
}

/**
 * Why a row is or is not safe to take through `down()` → `up()`.
 *
 * - `plaintext` — not an envelope. Legitimate: a row written before `T056_001` ran. `up()` will
 *   encrypt it, which is the state the policy requires anyway.
 * - `decryptable` — an envelope whose key material is reachable now.
 * - `unreadable` — an envelope that did not decrypt: unknown/retired kid, or a damaged value.
 *   The only verdict that blocks the suite.
 */
export type ForeignRowVerdict = 'plaintext' | 'decryptable' | 'unreadable';

export interface ForeignRowCheck {
  id: number;
  verdict: ForeignRowVerdict;
  /**
   * The `kid` embedded in the envelope, or `null` when the value is not an envelope or is too
   * malformed to name one. Reported so a blocked run says *which* key is missing.
   */
  kid: string | null;
  /**
   * A PII-free fingerprint of the address: its blind index. `null` when the address could not be
   * recovered.
   *
   * The blind index is used rather than the plaintext deliberately — it is a pure function of the
   * address under the active `blind_index` key, so two fingerprints taken in the same process are
   * equal exactly when the addresses are, and neither this object nor a failure message it ends
   * up in can leak somebody's email address into a test log.
   */
  fingerprint: string | null;
}

/** True for the one verdict that must stop the suite before it touches anything. */
export function isBlocking(check: ForeignRowCheck): boolean {
  return check.verdict === 'unreadable';
}

/**
 * Decides whether one foreign row can survive the round trip, without changing anything.
 *
 * Note that `decryptForRow` reports failure by *returning* {@link UNDECRYPTABLE_SENTINEL} rather
 * than throwing (see `portal-user.crypto`'s own reasoning: one bad row must not deny a whole
 * request), so the sentinel is checked explicitly. The `try`/`catch` is belt to that braces: it
 * covers a future in which some failure does throw, and a `parseCiphertext` that rejects a value
 * `looksLikeCiphertext` waved through — the latter is real, because `looksLikeCiphertext` is only
 * a `v1.` prefix test.
 */
export function classifyForeignRow(row: ForeignRow, crypto: EmailCryptoLike): ForeignRowCheck {
  if (!looksLikeCiphertext(row.email)) {
    return {
      id: row.id,
      verdict: 'plaintext',
      kid: null,
      fingerprint: crypto.blindIndexFor(row.email),
    };
  }

  let kid: string | null = null;
  try {
    kid = parseCiphertext(row.email).kid;
    const plaintext = crypto.decryptForRow(row.id, row.email);
    if (plaintext === UNDECRYPTABLE_SENTINEL) {
      return { id: row.id, verdict: 'unreadable', kid, fingerprint: null };
    }
    return {
      id: row.id,
      verdict: 'decryptable',
      kid,
      fingerprint: crypto.blindIndexFor(plaintext),
    };
  } catch {
    return { id: row.id, verdict: 'unreadable', kid, fingerprint: null };
  }
}

/**
 * The message a blocked run fails with.
 *
 * Deliberately actionable and deliberately *not* prescriptive about deletion: this harness cannot
 * tell "residue from a killed run" from "a real account whose key someone must restore", and
 * `test/support/encryption-keys.ts` makes the same distinction for the key table. It names the
 * ids and the kids and stops; a human decides. No address appears — see `fingerprint`.
 */
export function describeBlockedRows(blocked: readonly ForeignRowCheck[]): string {
  const rows = blocked
    .map((check) => `  - portal_users.id=${String(check.id)} (kid=${check.kid ?? 'unparseable'})`)
    .join('\n');

  return (
    `${String(blocked.length)} row(s) in reward_portal.portal_users cannot be decrypted with the ` +
    `key material this process can reach, so this suite must not run: it rolls the whole table ` +
    `through T056_001.down(), and down() refuses a row it cannot decrypt rather than replacing ` +
    `the address with a placeholder.\n${rows}\n` +
    `Restore the encryption key each row names, or remove the row if it is residue from an ` +
    `interrupted test run (see test/support/encryption-keys.ts for why an unreachable key ` +
    `protects nothing). Rows that *are* decryptable are fine and do not need deleting — this ` +
    `suite round-trips them and verifies their addresses are unchanged.`
  );
}

/**
 * Throws {@link describeBlockedRows} when any row is unreadable; otherwise returns the checks, in
 * input order, for the caller to compare against after the round trip.
 */
export function preflightForeignRows(
  rows: readonly ForeignRow[],
  crypto: EmailCryptoLike,
): ForeignRowCheck[] {
  const checks = rows.map((row) => classifyForeignRow(row, crypto));
  const blocked = checks.filter(isBlocking);
  if (blocked.length > 0) throw new Error(describeBlockedRows(blocked));
  return checks;
}
