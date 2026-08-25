/**
 * T-017 — the public surface of the data-protection engine.
 *
 * Import from `@/common/data-protection`, never from an individual file, so the internal layout
 * can change without a cross-task edit. The names Wave 3 and T-018/T-019 actually use are
 * `PolicyCacheService` (resolve a field's treatment), `createLogMaskingSerialiser` (install into
 * the logger), `applyMask` (render a masked value) and `DATA_PROTECTION_CONFIG` (the transport
 * settings T-018 reads).
 *
 * **`DataProtectionModule` is deliberately not re-exported here**, for the reason
 * `@/common/crypto`, `@/common/rbac` and `@/common/audit` all give: it imports `DatabaseModule`
 * → `ConfigModule`, whose `validate` runs `process.exit(1)` at *import* time when the
 * environment is incomplete. A barrel that reaches a `process.exit` is a barrel no unit test can
 * import, and these are the unit tests that have to reach 100% coverage. Import it from
 * `@/common/data-protection/data-protection.module`, which is a module file and nowhere else.
 */
export * from './data-protection.config';
export * from './data-protection.constants';
export * from './log-masking.serializer';
export * from './mask.strategies';
export * from './model-encryption.hooks';
export * from './policy-cache.service';
export * from './policy.repository';
export * from './policy.service';
export * from './response-masking.interceptor';
export * from './reveal.controller';
export * from './reveal.service';
