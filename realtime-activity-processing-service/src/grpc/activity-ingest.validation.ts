/**
 * T-RAP-022. Pure, transport-agnostic-in-shape wire-payload validators shared by every field this
 * task's own request-validation implementation notes call out: `activity_value` (decimal-as-string,
 * implementation note 1) and `activity_performed_date` (must carry an explicit UTC offset,
 * implementation note 4). Kept side-effect free and dependency-free (no NestJS, no gRPC types) so
 * a future Kafka `activity.ingest.v1` consumer (T-RAP-023, same file-scope owner,
 * `agent-rap-ingestion`) can import these exact functions rather than re-implementing — and
 * re-introducing — the same two checks against its own, differently-shaped wire payload
 * (`AGENT-PROTOCOL.md` R5's "a fix to one transport's bug must be automatically a fix to the
 * other's" spirit, applied here to shared *validation* rather than the shared domain method
 * `ActivityIngestionService.ingest` already covers).
 *
 * Neither function throws — both return a plain, inspectable result so a caller (the gRPC
 * controller, and later the Kafka consumer) decides its own error-shape translation
 * (`INVALID_ARGUMENT` gRPC status here; a DLQ-vs-retry decision there), matching this task's own
 * "reject with a clear error rather than letting a parse exception surface raw" implementation note.
 */

/**
 * `activity_value` is decimal-as-string on the wire (`03-GRPC-CONTRACT.md` §1) — this checks it
 * *looks like* a valid decimal number without ever converting it to a JS `number` (floating-point
 * precision loss is exactly what the decimal-as-string convention exists to avoid,
 * `campaign_config.proto`'s own `money` fields / `promo_code.v1.proto`'s own `reward_value` share
 * this same reasoning). Accepts an optional leading `-`, at least one digit, and an optional
 * `.`-delimited fractional part — rejects empty strings, scientific notation, thousands
 * separators, and a leading `+`.
 */
export function isValidDecimalString(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

/**
 * `activity_performed_date` must carry an explicit UTC offset (`03-GRPC-CONTRACT.md` §1's own
 * field comment: "REQUIRED to carry an explicit offset, not assumed UTC by omission") — a bare
 * `"2026-09-01 10:00:00"` with no `Z`/`+hh:mm`/`-hh:mm` suffix is rejected here, not silently
 * treated as UTC. Returns the parsed, UTC-normalized `Date` on success (mirrors
 * `inbound-activity.types.ts`'s own "normalized to UTC by the transport adapter before this object
 * is constructed"), or `null` when the value has no explicit offset or does not parse as a valid
 * date at all.
 */
export function parseActivityPerformedDate(value: string): Date | null {
  const trimmed = value.trim();
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    return null;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}
