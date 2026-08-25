/**
 * T-041 — the domain-specific error codes `/blasts` introduces, on top of the generic
 * catalogue `common/errors/app-error.ts` already provides.
 */
import { BusinessRuleError, ConflictError, type AppErrorOptions } from '@/common/errors/app-error';

export const BLAST_ERROR_CODE = Object.freeze({
  /** `POST /blasts`/`POST /blasts/preview` against a version that is not `published` (TC-14). */
  VERSION_NOT_PUBLISHED: 'BLAST_VERSION_NOT_PUBLISHED',
  /** `isBreaking` is `true` on the target version and the caller did not pass
   * `confirmBreaking: true` (implementation note 9, applied to the act of blasting). */
  BREAKING_CONFIRMATION_REQUIRED: 'BLAST_BREAKING_CONFIRMATION_REQUIRED',
  /** `scope: 'selected'` with an empty/absent `countryIds`, or a `countryId` that does not
   * resolve to a real, active country. */
  INVALID_COUNTRY_SELECTION: 'BLAST_INVALID_COUNTRY_SELECTION',
});

/** 422 — the version targeted by the blast is not `published` (TC-14: "Blast a `draft` version
 * → 422 — publish first"). */
export class VersionNotPublishedError extends BusinessRuleError {
  constructor(options: AppErrorOptions = {}) {
    super(BLAST_ERROR_CODE.VERSION_NOT_PUBLISHED, options);
  }
}

/** 422 — a breaking version blasted without an explicit confirmation. */
export class BreakingConfirmationRequiredError extends BusinessRuleError {
  constructor(options: AppErrorOptions = {}) {
    super(BLAST_ERROR_CODE.BREAKING_CONFIRMATION_REQUIRED, options);
  }
}

/** 409 — `scope`/`countryIds` do not agree, or a supplied country id does not resolve. Modelled
 * as a conflict (malformed *combination*, not a validation-shape failure `class-validator`
 * would already have caught) rather than a 422 — nothing about the request is a forbidden
 * business action, it is simply not a coherent one. */
export class InvalidCountrySelectionError extends ConflictError {
  constructor(options: AppErrorOptions = {}) {
    super(BLAST_ERROR_CODE.INVALID_COUNTRY_SELECTION, options);
  }
}
