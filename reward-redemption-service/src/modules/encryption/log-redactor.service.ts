/**
 * T-RR-005. The one place a log line is allowed to reference "which customer" without exposing
 * who that is (`07-CONFIGURABILITY-AND-OBSERVABILITY.md` §2, `AGENT-PROTOCOL.md` R8): it
 * substitutes the deterministic `customer_id_hash` for any raw `customerId` value passed to it.
 *
 * **Deliberately unconditional — does not consult `field_encryption_config`.** R8's "never
 * written to a log line ... in plaintext" and §2's "`customer_id_hash` ... is what appears in any
 * log or audit record that needs to reference 'which customer'" are both stated with no
 * conditional language: log-safety for `customerId` is not something an admin-togglable flag
 * should ever be able to relax. `field_encryption_config.enabled` (`FieldEncryptionConfigRepository`)
 * is a separate concern — implementation note 5's "gates encryption" — consumed directly by
 * whatever later task actually calls `EncryptionService.encrypt`/`decrypt` on a field (T-RR-010),
 * not by this always-on log-safety guarantee. Keeping this service synchronous and DB-free also
 * means routing a log statement through it never adds a database round trip to a hot log path.
 *
 * This is also the seam later tasks (T-RR-034/T-RR-035/T-RR-036) are expected to route every log
 * statement mentioning a customer through, rather than interpolating `customerId` directly.
 */
import { Injectable } from '@nestjs/common';
import { EncryptionService } from './encryption.service';

@Injectable()
export class LogRedactorService {
  constructor(private readonly encryption: EncryptionService) {}

  /**
   * Returns a value safe to place in a log line, error message, or any other observability
   * surface in place of a raw `customerId` (TC-8) — never the raw plaintext, never the reversible
   * ciphertext (a value log readers could otherwise correlate across log lines), always the
   * one-way `customer_id_hash`.
   */
  redactCustomerId(customerId: string): string {
    return this.encryption.hash(customerId);
  }
}
