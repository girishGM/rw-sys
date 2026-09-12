/**
 * T-RR-011. Pure, transport-agnostic-in-shape wire-payload validators for the two fields
 * `03-GRPC-CONTRACT.md` §1/`RewardEntryIngestDto` (T-RR-010) require extra scrutiny for:
 * `activity_value`/`reward_value` (decimal-as-string) and `activity_performed_date`/
 * `reward_entry_date` (full ISO-8601 with an explicit zone offset). Kept side-effect free and
 * dependency-free (no NestJS, no gRPC types) so the Kafka consumer (T-RR-012) and REST controller
 * (T-RR-013) — same file-scope owner, `agent-rr-ingestion` — can import these exact functions
 * rather than re-implementing, and re-introducing, the same two checks against their own
 * differently-shaped wire payloads (R10's "identical behavior regardless of channel" applied here
 * to shared *validation* rather than the shared domain method `RewardIngestionService.ingest`
 * already covers). Same precedent RAP's own `activity-ingest.validation.ts` set for the sibling
 * project (confirmed by direct read).
 *
 * Neither function throws — both return a plain, inspectable result so a caller (this gRPC
 * controller here; later the Kafka consumer/REST controller) decides its own error-shape
 * translation (`INVALID_ARGUMENT` gRPC status here; an HTTP `400` there; a DLQ-vs-retry decision
 * for Kafka).
 */

/**
 * `activity_value`/`reward_value` are decimal-as-string on the wire (`03-GRPC-CONTRACT.md` §1) —
 * this checks the value *looks like* a valid decimal number without ever converting it to a JS
 * `number` (floating-point precision loss is exactly what the decimal-as-string convention exists
 * to avoid). Accepts an optional leading `-`, at least one digit, and an optional `.`-delimited
 * fractional part — rejects empty strings, scientific notation, thousands separators, and a
 * leading `+`.
 */
export function isValidDecimalString(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

/**
 * `activity_performed_date`/`reward_entry_date` must carry an explicit UTC offset — a bare
 * `"2026-09-01 10:00:00"` with no `Z`/`+hh:mm`/`-hh:mm` suffix is rejected here, not silently
 * treated as UTC. Returns the parsed, UTC-normalized `Date` on success, or `null` when the value
 * has no explicit offset or does not parse as a valid date at all.
 */
export function parseIsoDateWithOffset(value: string): Date | null {
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

/**
 * T-INT-058. RAP's own `reward_kind` values (`reward-entry.model.ts`'s own header, RAP's copy —
 * this service never derives or enforces this list itself, it only recognizes it well enough to
 * type the ingest DTO field honestly). Descriptive-only metadata, never a new enforcement input
 * (RAP's own proto comment) — kept here, alongside the other wire-payload normalizers this file's
 * own header already documents as shared by all three transport adapters (`agent-rr-ingestion`).
 */
export const REWARD_KIND_VALUES = ['PERCENTAGE', 'FIXED_AMOUNT', 'POINTS', 'PROMO_CODE'] as const;
export type RewardKind = (typeof REWARD_KIND_VALUES)[number];

/**
 * Normalizes an inbound `reward_kind` wire value to one of RAP's own known values, or `null` for
 * anything else — absent (`undefined`), empty string (proto3's own "unset" convention, this file's
 * own header), `null`, or a value this service does not recognize. Never throws: an unrecognized
 * value is not a malformed request (this field is purely descriptive, per T-RAP-062's own
 * comment), so it degrades to `null` rather than rejecting the whole entry.
 */
export function parseRewardKind(value: unknown): RewardKind | null {
  return typeof value === 'string' && (REWARD_KIND_VALUES as readonly string[]).includes(value)
    ? (value as RewardKind)
    : null;
}

/**
 * T-INT-058. `promo_code_config_version_no` is a proto3 `int32` — `0`/absent both mean "not set"
 * (RAP's own `reward-grpc-fallback.client.ts` sends `?? 0` for exactly this reason, confirmed by
 * direct read). A real config version is always a positive integer (versions start at 1), so any
 * non-positive or non-integer value normalizes to `null` rather than being persisted as a fake
 * version number.
 */
export function parsePromoCodeConfigVersionNo(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
