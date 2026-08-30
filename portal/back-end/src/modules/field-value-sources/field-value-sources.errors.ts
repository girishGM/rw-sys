/**
 * T-121 — the domain-specific error codes the field value-source registries introduce.
 *
 * Neither code has a `system_messages` row yet — the same deviation `rules.errors.ts` records for
 * T-031's own new codes: `MessageService` degrades to returning the key itself, which is safe (no
 * internal detail leaks) but unlocalised until a seed migration adds them. Seed migrations for
 * `system_messages` are outside this module's file scope.
 */
import { ConflictError, type AppErrorOptions } from '@/common/errors/app-error';

export const FIELD_VALUE_SOURCE_ERROR_CODE = Object.freeze({
  /** `uq_fcp_code` — a context provider code is already in use (TC-6). */
  FIELD_CONTEXT_PROVIDER_CODE_EXISTS: 'FIELD_CONTEXT_PROVIDER_CODE_EXISTS',
  /** `uq_falp_code` — an API lookup provider code is already in use (TC-6). */
  FIELD_API_LOOKUP_PROVIDER_CODE_EXISTS: 'FIELD_API_LOOKUP_PROVIDER_CODE_EXISTS',
});

/** 409 — `POST /field-context-providers` with a `providerCode` already in use. */
export class FieldContextProviderCodeExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(FIELD_VALUE_SOURCE_ERROR_CODE.FIELD_CONTEXT_PROVIDER_CODE_EXISTS, options);
  }
}

/** 409 — `POST /field-api-lookup-providers` with a `providerCode` already in use. */
export class FieldApiLookupProviderCodeExistsError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(FIELD_VALUE_SOURCE_ERROR_CODE.FIELD_API_LOOKUP_PROVIDER_CODE_EXISTS, options);
  }
}
