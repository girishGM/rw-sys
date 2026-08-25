/**
 * T-014 — the public surface of the error layer, for Wave 3.
 *
 * A feature task needs three things from here: `AppError` and its subclasses to throw,
 * `ERROR_CODE` to name what went wrong, and — in a test — `isSafeErrorCode` to assert that a new
 * code is one the filter will let through.
 *
 * `ErrorsModule` is deliberately absent, for the reason `@/common/rbac`'s barrel gives about
 * `RbacModule`: importing a module pulls `ConfigModule`'s boot-time environment validation into
 * whatever imports it, including unit tests that only wanted an error class.
 */
export * from './app-error';
export * from './error-normalization.filter';
export * from './trace-id';
export * from './validation.exception-factory';
