/**
 * T-RR-040. `LogRedactorService` — the observability-layer safety net over
 * `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §2/§4 and `AGENT-PROTOCOL.md` R8: given a full
 * structured-log fields object, returns a copy with every denylisted field name (currently just
 * `customerId`, the one PII field this service ever handles at rest, R8) replaced by its one-way
 * hash — the same value `EncryptionService.hash()` (and the encryption module's own
 * `LogRedactorService.redactCustomerId()`, `src/modules/encryption/log-redactor.service.ts`,
 * T-RR-005) already produce, so a value redacted here is byte-identical to the `customer_id_hash`
 * column a reader may already be comparing it against. `correlationId` is on an explicit allowlist
 * that always wins, even if it were ever added to the denylist by mistake (§4: "carries no customer
 * information by construction ... the entire point of tracing").
 *
 * **Composes, does not duplicate, T-RR-005's own `LogRedactorService`** (`AGENT-PROTOCOL.md` R3 —
 * `src/modules/encryption/**` is `agent-rr-foundation`'s file scope, not this task's). That service's
 * job is a single-value transform (`redactCustomerId(customerId: string): string`) a call site
 * invokes explicitly, once it already knows it is about to log a raw `customerId` — every real
 * ingestion/connector call site already does this correctly (confirmed by this task's own audit).
 * This service's job is the wider, defense-in-depth one implementation note 4 describes: a
 * `StructuredLogger.log(fields)` call scans the *whole* fields object for a caller who forgot to call
 * that transform at all, so the guarantee ("customer_id_hash, never the encrypted or plaintext form,
 * is what appears in any log ... record", §2) holds even against a mistake at the call site, not just
 * against a disciplined one.
 *
 * Reuses `EncryptionService` (not the narrower `src/modules/encryption/log-redactor.service.ts`)
 * directly, since the operation this class performs (object-shaped, not single-value) is a different
 * shape from that file's own `redactCustomerId` — this avoids introducing a second class with the
 * exact same exported name and a subtly different contract, which would be more confusing than a
 * direct dependency on the one primitive both ultimately need (`EncryptionService.hash`).
 */
import { Injectable } from '@nestjs/common';
import { EncryptionService } from '@/modules/encryption/encryption.service';

/** Field names this service is responsible for catching if a caller passes them raw (currently just
 * the one PII field this whole service ever handles, R8) — deliberately not a general "looks like
 * PII" heuristic, which would be prone to both false positives (redacting an unrelated field that
 * happens to share a name) and false negatives (silently missing a field this list doesn't yet know
 * about). Add a name here only when a new field genuinely carries raw customer-identifying data. */
const REDACTED_FIELD_NAMES: ReadonlySet<string> = new Set(['customerId']);

/** Never redacted, unconditionally, even if a future edit to `REDACTED_FIELD_NAMES` above ever
 * collided with one of these — `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §4's own explicit
 * "correlationId is never redacted anywhere ... the entire point of tracing". Checked first, so it
 * always wins. */
const NEVER_REDACTED_FIELD_NAMES: ReadonlySet<string> = new Set(['correlationId']);

@Injectable()
export class LogRedactorService {
  constructor(private readonly encryption: EncryptionService) {}

  /**
   * Returns a shallow copy of `fields` with every denylisted field's value replaced by its one-way
   * hash — never the plaintext, never a reversible ciphertext. Fields not on
   * `REDACTED_FIELD_NAMES` (or explicitly on `NEVER_REDACTED_FIELD_NAMES`) pass through completely
   * unchanged, including non-string values (e.g. `tenantId`, a number, is never coerced or touched).
   * A denylisted field whose value is not a string (should never happen for `customerId`, but this
   * method does not trust that) is also passed through unchanged rather than crash a log call —
   * observability code must never be the reason a request fails.
   */
  redactFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (
        !NEVER_REDACTED_FIELD_NAMES.has(key) &&
        REDACTED_FIELD_NAMES.has(key) &&
        typeof value === 'string'
      ) {
        result[key] = this.encryption.hash(value);
        continue;
      }
      result[key] = value;
    }
    return result;
  }
}
