/**
 * T-067 — recovering from encryption-key rows that a killed test run left behind.
 *
 * ### The defect this exists to close
 *
 * Every e2e suite that touches encrypted data needs an `encryption_keys` row before
 * `app.init()`, because `KeyRegistryService` reads the table exactly once, at boot. The
 * established pattern for producing one is:
 *
 * ```ts
 * process.env.SOME_SUITE_KEY = randomBytes(32).toString('base64');  // ephemeral: in RAM only
 * INSERT INTO reward_portal.encryption_keys (kid, key_ref, …) VALUES (…, 'env:SOME_SUITE_KEY', …)
 * ```
 *
 * followed by a `DELETE` in `afterAll`. Note the asymmetry that makes this unsafe: **the row is
 * durable and the key material is not.** The material only ever existed in one process's memory
 * and is unrecoverable the moment that process ends. So the `afterAll` is not merely good
 * hygiene — it is the *only* thing standing between a normal test run and a permanently
 * unbootable database.
 *
 * And `afterAll` does not run when the process is killed: Ctrl-C, a jest worker crash, `--bail`,
 * an OOM, a Playwright run abandoned half-way. Residue is therefore not an accident that better
 * discipline prevents; it is the **expected** outcome of any abnormal termination. That is why
 * the remedy here is recovery-on-next-run rather than "remember to clean up": no amount of
 * cleanup code that runs at the *end* can close a hole that opens when the end never arrives.
 *
 * The observed consequence (T-062, T-061, and by hand on 2026-08-19) is that the next boot of
 * *anything* against the shared local database — a suite, `npm run start:dev`, `bootstrap:
 * superadmin` — dies with `KeyRegistryError: Environment variable 'T031_T056_FIELD_KEY' … is not
 * set`, because the registry resolves every row in the table, not just the ones the caller cares
 * about. Ten such rows had accumulated by 2026-08-21.
 *
 * ### What was deliberately NOT changed
 *
 * The obvious-looking fix is to make `KeyRegistryService` tolerate an unresolvable key when its
 * status is not `active` — every orphan observed was `rotating`. **That fix was considered and
 * rejected**, and the reasoning is worth keeping because it will look tempting again:
 *
 *  - A `rotating` key is decrypt-only, and decrypting old rows is precisely what it is *for*.
 *    During a real rotation, an unresolvable `rotating` key means the operator forgot to ship
 *    the old key's material — and the rows encrypted under it are now unreadable.
 *  - The registry cannot tell "test residue protecting nothing" from "the old production key,
 *    still protecting a million rows" by looking at the row. It holds no inventory of which
 *    columns contain ciphertext under which kid, and cannot acquire one generically.
 *  - So relaxing the check would trade a loud, immediate boot failure for silent per-row
 *    `unknown_key` errors surfacing later, in production, for a subset of users — in exchange
 *    for tidying up after a test suite. That is weakening a guard to make a test pass
 *    (AGENT-PROTOCOL §7), and the boot check stays exactly as strict as it was.
 *
 * The asymmetry is resolved on the *test* side instead, where the ownership question has an
 * answer: this module knows which kids the harness creates, so it can prove a row is residue.
 *
 * ### Why deleting these rows is safe
 *
 * `sweepOrphanedTestKeys` removes a row only when **both** hold:
 *
 *  1. its `kid` is in a namespace this test harness owns ({@link isTestOwnedKid}) — nothing a
 *     deployment created can match; and
 *  2. its `key_ref` names an environment variable that is absent from the current process —
 *     which means the row already fails `KeyRegistryService.load()` for everybody, and the key
 *     it points at can decrypt nothing, for anybody, ever again.
 *
 * Condition 2 alone makes the deletion lossless: an unresolvable key protects no accessible
 * data by definition. Condition 1 is the belt to that braces — it keeps a mistake in this file
 * from ever reaching a row a deployment cares about.
 *
 * Note what is deliberately *not* in the predicate: **status**. Sweeping only non-`active` rows
 * would be the conservative-looking choice, but the helpers insert as `active` whenever the
 * database has no active key of that purpose — so a run killed against a clean database (i.e.
 * CI) leaves an *active* orphan, which is exactly the case that most needs recovering. The
 * namespace check, not the status, is what makes this safe.
 */
import { randomBytes } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';

/**
 * The reserved prefix for any *new* harness-created kid. Existing suites predate it and are
 * matched by {@link LEGACY_TEST_KID_PATTERNS} instead; prefer this one for anything new, because
 * a single prefix is a far stronger ownership signal than a list of per-suite spellings.
 */
export const TEST_KID_PREFIX = 'testkey_';

/**
 * Kid shapes that existing suites already create, enumerated so the sweep can recover residue
 * they left before `TEST_KID_PREFIX` existed. Each entry names the file that produces it, so
 * that deleting a suite and deleting its pattern stay one action apart rather than one guess.
 *
 * These are matched against the kid only — never against a deployment-supplied value — and each
 * is anchored, so `field_20260101` (the shape `encryption-keys.ts provision` generates) and
 * `dev_local_fld` (this machine's real local keys) match nothing here.
 */
export const LEGACY_TEST_KID_PATTERNS: readonly RegExp[] = [
  /^t016_e2e_/, //                test/crypto/crypto.e2e-spec.ts
  /^t017_e2e_/, //                test/data-protection/data-protection.e2e-spec.ts
  /^t018_e2e_/, //                test/transport-crypto/transport-crypto.e2e-spec.ts
  /^t055_e2e_/, //                test/auth/mfa.e2e-spec.ts
  /^t056_backfill_/, //           test/data-protection/t056-backfill.e2e-spec.ts
  /^[a-z0-9]+_t056_(fld|bidx)$/, // test/auth/support/portal-user-fixture.ts (28 suites)
  /^[a-z0-9]+_mfa_fld$/, //       test/auth/support/super-admin-mfa.ts
];

/** True when `kid` belongs to a namespace this test harness creates and owns. */
export function isTestOwnedKid(kid: string): boolean {
  if (kid.startsWith(TEST_KID_PREFIX)) return true;
  return LEGACY_TEST_KID_PATTERNS.some((pattern) => pattern.test(kid));
}

/**
 * True when `keyRef`'s key material can be found in `env`.
 *
 * A ref this function does not understand (`kms:…`, or anything without a scheme) counts as
 * resolvable, so that it is never swept. Judging a KMS key's reachability is not something a
 * test helper can do, and the conservative answer — leave it alone — is the right one.
 */
export function isKeyRefResolvable(keyRef: string, env: NodeJS.ProcessEnv): boolean {
  if (!keyRef.startsWith('env:')) return true;
  const value = env[keyRef.slice('env:'.length)];
  return value !== undefined && value !== '';
}

/**
 * Deletes every harness-owned `encryption_keys` row whose key material this process cannot
 * reach, and returns the kids removed (empty when there was nothing to do).
 *
 * Call this **before** inserting a suite's own keys and before `app.init()`. It is idempotent,
 * cheap (one SELECT over a table with single-digit row counts), and safe to run concurrently —
 * the DELETE is by explicit kid list, so two workers racing simply agree.
 */
export async function sweepOrphanedTestKeys(
  sequelize: Sequelize,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const rows = await sequelize.query<{ kid: string; key_ref: string }>(
    `SELECT kid, key_ref FROM reward_portal.encryption_keys`,
    { type: QueryTypes.SELECT },
  );

  const orphans = rows
    .filter((row) => isTestOwnedKid(row.kid) && !isKeyRefResolvable(row.key_ref, env))
    .map((row) => row.kid);

  if (orphans.length === 0) return [];

  await sequelize.query(`DELETE FROM reward_portal.encryption_keys WHERE kid IN (:kids)`, {
    type: QueryTypes.DELETE,
    replacements: { kids: orphans },
  });

  // Never silent: a suite that quietly repairs the database teaches nobody that a previous run
  // was killed, and the count is the only signal that residue is accumulating faster than runs
  // are finishing cleanly.
  // eslint-disable-next-line no-console -- T-067: test-harness diagnostics, not application code.
  console.warn(
    `[T-067] Removed ${orphans.length} orphaned test encryption_keys row(s) left by an ` +
      `interrupted run: ${orphans.join(', ')}`,
  );

  return orphans;
}

/** 32 random bytes, base64 — the encoding `EnvKeyMaterialResolver` expects by default. */
export function generateKeyMaterial(): string {
  return randomBytes(32).toString('base64');
}
