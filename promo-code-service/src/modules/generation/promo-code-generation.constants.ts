/**
 * T-PC-021. Small DI tokens/constants for this module, same pattern as
 * `promo-code-config.constants.ts` (T-PC-010).
 */

/**
 * The configurable collision-retry ceiling (implementation note 3, `03-GRPC-CONTRACT.md` §4:
 * "default 5"). A DI token rather than a hardcoded literal so tests can override it (TC-15, e.g.
 * `new PromoCodeGenerationService(..., 2)`) without touching `ConfigModule`'s own required-env
 * schema (`src/config/config.schema.ts`, outside this task's file scope) — this is a tunable with
 * a safe default, not a required secret/connection string, so it deliberately does not extend
 * that schema (see `promo-code-generation.module.ts`'s own header for how the default is wired).
 */
export const GENERATION_MAX_RETRY_ATTEMPTS = Symbol('GENERATION_MAX_RETRY_ATTEMPTS');
export const DEFAULT_GENERATION_MAX_RETRY_ATTEMPTS = 5;

/** `02-KAFKA-CONTRACTS.md` §5 — the topic the outbox row is destined for (T-PC-022 publishes it). */
export const GENERATE_RESULT_TOPIC = 'promo-code.generate.result.v1';
