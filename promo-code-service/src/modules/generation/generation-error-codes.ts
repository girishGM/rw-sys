/**
 * T-PC-021. The stable, machine-readable failure codes `PromoCodeGenerationService.generateCode`
 * can return on `GenerationResult.errorCode` — exactly the four values `02-KAFKA-CONTRACTS.md` §5
 * and `03-GRPC-CONTRACT.md` §5 both specify (same codes, both transports, per `ARCHITECTURE.md`
 * §6/R10: one domain service, one error vocabulary). Kept in its own file so both transport
 * adapters (T-PC-030/T-PC-031, out of this task's scope) can import just this list without
 * pulling in the rest of the service.
 */
export const GENERATION_ERROR_CODES = [
  'CONFIG_NOT_BOUND',
  'CONFIG_INACTIVE',
  'GENERATION_EXHAUSTED',
  'INVALID_REQUEST',
  // T-PC-060: an explicit, caller-supplied `versionNo` (`02-KAFKA-CONTRACTS.md` §3/
  // `03-GRPC-CONTRACT.md` §1's `version_no`) that does not resolve to any
  // `promo_code_config_version` row for the request's own resolved `promoCodeConfigId` — either
  // the version number doesn't exist at all, or it belongs to a *different* config. Append-only
  // (R8) — a new, additive failure outcome, never a reinterpretation of the existing four.
  // **Flagged for the architect (AGENT-PROTOCOL.md §3):** neither `02-KAFKA-CONTRACTS.md` §5 nor
  // `03-GRPC-CONTRACT.md` §5's `errorCode` enum lists this value yet — both files are outside this
  // task's granted scope (messaging's `Edit(promo-code-service-plan/02-KAFKA-CONTRACTS.md)`; no
  // agent currently has a grant for `03-GRPC-CONTRACT.md` at all, a pre-existing gap unrelated to
  // this task). This is additive to the wire contract (a new string value on an already-untyped
  // `string | null` field), not a breaking change, but the docs should be updated to match.
  'VERSION_NOT_FOUND',
] as const;

export type GenerationErrorCode = (typeof GENERATION_ERROR_CODES)[number];
