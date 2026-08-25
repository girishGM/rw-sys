/**
 * T-014 — the public surface of the audit layer, for Wave 3.
 *
 * Import from `@/common/audit`. The three names a feature task actually uses are `Audit` (the
 * decorator), `AuditService` (`annotate` and `diffFields`) and the two constant objects that
 * name what `campaign_audit_trail` will accept.
 *
 * **`AuditModule` is deliberately absent**, for the reason `@/common/rbac`'s barrel gives: it
 * imports `DatabaseModule` and therefore `ConfigModule`, whose environment validation runs at
 * module-evaluation time — pulling that into a unit test of a decorator would turn a failed
 * assertion into a `process.exit(1)`. Import it from `@/common/audit/audit.module`, which is a
 * module file and nowhere else.
 */
export * from './audit-context';
export * from './audit.constants';
export * from './audit.interceptor';
export * from './audit.repository';
export * from './audit.service';
export * from './decorators/audit.decorator';
