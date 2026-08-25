/**
 * T-017 — the barrel's contract with its consumers.
 *
 * Two things are asserted, and the second is the one that matters.
 *
 * **The names T-018, T-019 and Wave 3 import are present.** A barrel is an API; dropping an
 * export from it is a breaking change that `tsc` only catches in the consumer, which may be a
 * task that has not been written yet.
 *
 * **Importing it does not reach a `process.exit`.** `@/common/crypto`, `@/common/rbac` and
 * `@/common/audit` all document the same hazard: a barrel that re-exports its Nest module pulls
 * in `DatabaseModule` → `ConfigModule`, whose `validate` calls `process.exit(1)` at *import*
 * time when the environment is incomplete — and a barrel no unit test can import is a barrel
 * that silently stops being tested. This spec importing the barrel at all *is* the assertion;
 * `DataProtectionModule` being absent from it is what makes that possible.
 */
import * as barrel from '@/common/data-protection';

describe('@/common/data-protection', () => {
  it('exports what its consumers import', () => {
    for (const name of [
      // T-019 / T-052 install this into the logger transport.
      'createLogMaskingSerialiser',
      'maskForLog',
      // T-018 reads transport settings and per-field `in_transit`.
      'DATA_PROTECTION_CONFIG',
      'loadDataProtectionConfig',
      'PolicyCacheService',
      // Wave 3 renders masked values and reads the policy vocabulary.
      'applyMask',
      'PolicySet',
      'UNDECRYPTABLE_SENTINEL',
      'ResponseMaskingInterceptor',
      'NoResponseMasking',
      'RevealController',
      'RevealService',
      'installEncryptionHooks',
      'POLICY_STORE',
    ]) {
      expect(barrel).toHaveProperty(name);
    }
  });

  it('does NOT export the Nest module — see this file"s header', () => {
    expect(barrel).not.toHaveProperty('DataProtectionModule');
  });
});
