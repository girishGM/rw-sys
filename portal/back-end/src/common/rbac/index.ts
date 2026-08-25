/**
 * T-013 — the public surface of the RBAC layer, for Wave 3.
 *
 * Import from `@/common/rbac`, not from the individual files: the internals (the store token,
 * the route-metadata reader) are exported here too because the tests need them, but the three
 * names a feature task actually uses are `Roles`, `RequirePermission` and `assertRole`.
 *
 * **`RbacModule` is deliberately absent.** Re-exporting it would make every consumer of a
 * decorator transitively import `ConfigModule`, whose `forRoot` validates the environment at
 * *module-evaluation* time and calls `process.exit(1)` when it cannot — which turns a unit test
 * of a guard into a process kill. Import it from `@/common/rbac/rbac.module` where it is
 * actually needed, which is a module file and nowhere else.
 */
export * from './assert-role';
export * from './decorators/require-permission.decorator';
export * from './decorators/roles.decorator';
export * from './permission-cache.service';
export * from './permission.repository';
export * from './permissions.guard';
export * from './rbac.constants';
export * from './rbac.exceptions';
export * from './roles.guard';
export * from './route-authorisation';
