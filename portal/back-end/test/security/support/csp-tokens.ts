/**
 * T-012 test support — the two CSP source expressions the policy must never contain.
 *
 * They live here, and **only** here, rather than in `src/common/security/security.constants.ts`
 * where they started. The reason is T-012 verification step 6:
 *
 * ```
 * grep -rn "unsafe-inline\|unsafe-eval" back-end/src   →   Zero matches
 * ```
 *
 * A guard-rail constant listing the forbidden tokens is useful, but it also puts both strings
 * into `src`, which turns that verification step into two matches a reviewer has to read,
 * understand and dismiss — every time, forever. A check whose expected output is "some hits,
 * but the harmless kind" is a check people stop running. Keeping the literals in the test that
 * forbids them means the grep answers zero, and the assertion is no weaker: the specs import
 * from here and compare against the CSP the application actually serves.
 */

/** `'unsafe-inline'` and `'unsafe-eval'`. Never permitted in any directive of this system's CSP. */
export const FORBIDDEN_CSP_TOKENS: readonly string[] = Object.freeze([
  "'unsafe-inline'",
  "'unsafe-eval'",
]);
