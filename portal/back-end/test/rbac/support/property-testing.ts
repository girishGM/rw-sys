/**
 * T-013 — the property-testing harness for the AR-17 suite, re-exported from the one T-016
 * built.
 *
 * `fast-check` is still not a dependency of this workspace and still cannot be added from inside
 * a task (`npm install` is outside the permitted command set; see
 * `test/crypto/support/property-testing.ts`'s header for the full argument and for exactly what
 * is and is not equivalent — the headline being *no shrinking*). Rather than write a second
 * seeded generator, this file points at that one.
 *
 * Both files are owned by `agent-security`, so the cross-directory import is not a scope
 * violation; it is stated here rather than left for a reviewer to work out. When `fast-check` is
 * eventually taken as a dependency, this file is deleted and the two property suites change one
 * import line each.
 */
export { default } from '../../crypto/support/property-testing';
