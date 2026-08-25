/**
 * T-056 unit-test support — a real {@link PortalUserEmailCrypto} for the repository specs.
 *
 * Deliberately **not** a stub. The three repositories under test are the code that decides which
 * value goes into `WHERE email_bidx = :bidx` and what comes back out of an encrypted column, and a
 * hand-written double would let both sides agree on a convention that the production crypto does not
 * actually implement — which is precisely the failure mode this task exists to prevent. Wiring the
 * genuine `FieldCryptoService`/`BlindIndexService` over T-016's in-memory test registry costs
 * nothing (no database, no I/O) and means a mismatch between the index written on one path and the
 * index computed on another shows up here rather than in production.
 *
 * The keys come from `test/crypto/support/keys.ts`, so they are the same generated-from-a-seed test
 * keys the crypto suite uses and `scan:secrets` has nothing to find.
 */
import { BlindIndexService, FieldCryptoService } from '@/common/crypto';
import { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import { buildDefaultRegistry } from '../../crypto/support/keys';

/**
 * A real email-crypto over test keys.
 *
 * `bindRecordIdAsAAD` defaults to `true`, matching `config/data-protection.json`'s shipped value —
 * pass `false` to exercise the documented downgrade path.
 */
export async function buildEmailCrypto(bindRecordIdAsAAD = true): Promise<PortalUserEmailCrypto> {
  const registry = await buildDefaultRegistry();
  return new PortalUserEmailCrypto(
    new FieldCryptoService(registry),
    new BlindIndexService(registry),
    bindRecordIdAsAAD,
  );
}
