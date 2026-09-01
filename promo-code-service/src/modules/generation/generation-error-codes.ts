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
] as const;

export type GenerationErrorCode = (typeof GENERATION_ERROR_CODES)[number];
