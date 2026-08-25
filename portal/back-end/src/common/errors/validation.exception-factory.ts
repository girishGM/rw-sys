/**
 * T-014 — turns `class-validator`'s output into `details: [{ field, code }]` (TC-11).
 *
 * ### Why the default `ValidationPipe` output cannot be used
 *
 * Nest's default `exceptionFactory` flattens every failure into an array of English sentences:
 *
 * ```json
 * { "statusCode": 400, "message": ["email must be an email", "budgetAmount must not be less than 0"],
 *   "error": "Bad Request" }
 * ```
 *
 * Three things are wrong with shipping that to a client, and 03-API-CONTRACT.md §1 rules out all
 * three: it is prose rather than `{ field, code }`, so the SPA cannot render a message next to
 * the offending input without string-matching; it is unlocalisable; and it is *internal text* —
 * the exact category of thing TC-11 says must not appear ("no internal messages"). Sentences
 * from a validator are also a slow leak of implementation detail: `whitelistValidation` prints
 * *"property tenantId should not exist"*, which tells a caller precisely which server-derived
 * field it tried to smuggle in and that the server knows the name.
 *
 * So the structure is preserved instead of the prose. `property` becomes `field`, the
 * **constraint name** (not its message) becomes `code`, and nested DTOs produce dotted paths.
 *
 * ### Installed in `main.ts`
 *
 * `new ValidationPipe({ ..., exceptionFactory: validationExceptionFactory })`. That one option
 * is this task's only change to a file it does not own; it is additive, and without it TC-11
 * cannot pass — the structured `ValidationError[]` exists nowhere else. Recorded as a deviation
 * in the completion report.
 */
import type { ValidationError } from 'class-validator';
import { ERROR_CODE, ValidationFailedError, isSafeErrorCode, type ErrorDetail } from './app-error';

/**
 * Constraint names whose generic conversion would be unhelpful or misleading to a client.
 *
 * Everything not listed here converts mechanically (`isEmail` → `IS_EMAIL`), which is stable,
 * predictable and needs no maintenance as DTOs grow.
 */
const CONSTRAINT_CODE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  isDefined: 'REQUIRED',
  isNotEmpty: 'REQUIRED',
  // `forbidNonWhitelisted` — the DTO carried a property it does not declare. AGENT-PROTOCOL R3
  // makes this a security-relevant outcome (a client-supplied `tenantId`), so it gets a name of
  // its own rather than a mechanical one.
  whitelistValidation: 'UNEXPECTED_FIELD',
});

/** Used when a constraint name converts to something that would fail `SAFE_ERROR_CODE_PATTERN`. */
const FALLBACK_DETAIL_CODE = 'INVALID_VALUE';

/**
 * The `exceptionFactory` for the global `ValidationPipe`.
 *
 * Returns a {@link ValidationFailedError}, which `ErrorNormalizationFilter` renders as a 400 with
 * `code: VALIDATION_FAILED`. Returning (rather than throwing) is what `ValidationPipe` expects.
 */
export function validationExceptionFactory(errors: ValidationError[]): ValidationFailedError {
  const details = flattenValidationErrors(errors);
  return new ValidationFailedError(details, {
    // Server log only — never serialised (see `app-error.ts`). The count, not the values: a
    // rejected DTO is exactly the place a plaintext password is most likely to be sitting.
    logMessage: `${ERROR_CODE.VALIDATION_FAILED}: ${details.length} field(s) rejected`,
    logContext: { fields: details.map((detail) => detail.field) },
  });
}

/**
 * Depth-first walk of `class-validator`'s tree into a flat `{ field, code }` list.
 *
 * Array elements arrive with a numeric `property` (`"0"`), which becomes `policies[0].unitCode`
 * rather than `policies.0.unitCode` — the form that matches how a client addresses its own form
 * state.
 */
export function flattenValidationErrors(
  errors: readonly ValidationError[],
  parentPath = '',
): ErrorDetail[] {
  const details: ErrorDetail[] = [];

  for (const error of errors) {
    const path = joinPath(parentPath, error.property);

    for (const constraint of Object.keys(error.constraints ?? {})) {
      details.push({ field: path, code: constraintCode(constraint) });
    }

    if (error.children !== undefined && error.children.length > 0) {
      details.push(...flattenValidationErrors(error.children, path));
    }
  }

  return details;
}

function joinPath(parentPath: string, property: string): string {
  if (parentPath === '') return property;
  return /^\d+$/.test(property) ? `${parentPath}[${property}]` : `${parentPath}.${property}`;
}

/** `isEmail` → `IS_EMAIL`; `maxLength` → `MAX_LENGTH`; aliases above take precedence. */
export function constraintCode(constraint: string): string {
  const alias = CONSTRAINT_CODE_ALIASES[constraint];
  if (alias !== undefined) return alias;

  const code = constraint
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();

  return isSafeErrorCode(code) ? code : FALLBACK_DETAIL_CODE;
}
