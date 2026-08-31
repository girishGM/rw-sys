/**
 * Coverage thresholds are intentionally modest at the workspace level — AGENT-PROTOCOL.md's
 * real bar is per-task (>=80% on changed files; 100% on guards/scope/auth). Tasks that own
 * security-critical modules (T-013, T-016, ...) add their own stricter `coverageThreshold`
 * entries here, scoped by path glob; do not lower this file's global floor to make a
 * specific module's shortfall pass.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  // T-016: unit specs for `src/common/crypto/**` live in `test/crypto/`, because that is the
  // directory the task file grants T-016 ownership of. `rootDir` stays `src` so coverage
  // collection and the `@/` alias are unchanged; `roots` only widens where tests are looked
  // for. e2e specs in the same folder are named `*.e2e-spec.ts` and are therefore not matched
  // by `testRegex` here — they run under `test/jest-e2e.json` against the real database.
  // T-010: same arrangement for `src/modules/auth/**`, whose specs the task file places in
  // `test/auth/`. e2e specs there follow the same `*.e2e-spec.ts` naming and are likewise
  // not matched by `testRegex`.
  // T-012: same arrangement again for `src/common/security/**`, whose unit specs live in
  // `test/security/` — the directory that task file grants it. `hardening.e2e-spec.ts` in the
  // same folder is, as above, not matched by `testRegex` and runs under `test/jest-e2e.json`.
  // T-013: same arrangement once more for `src/common/rbac/**` and `src/common/scope/**`, whose
  // unit specs live in `test/rbac/` — the directory that task file grants it. `rbac.e2e-spec.ts`
  // in the same folder is, as above, not matched by `testRegex` and runs under
  // `test/jest-e2e.json` against the real database.
  // T-014: same arrangement once more for `src/common/audit/**`, `src/common/errors/**`,
  // `src/common/messages/**` and `src/common/logging/redact.ts`, whose unit specs live in
  // `test/common/` — the directory that task file grants it. `audit.e2e-spec.ts` in the same
  // folder is, as above, not matched by `testRegex` and runs under `test/jest-e2e.json` against
  // the real database.
  // T-015: same arrangement once more for `src/modules/me/**`, whose unit specs live in
  // `test/me/` — the directory that task file grants it. `me.e2e-spec.ts` in the same folder is,
  // as above, not matched by `testRegex` and runs under `test/jest-e2e.json` against the real
  // database.
  // T-017: same arrangement once more for `src/common/data-protection/**`, whose unit specs live
  // in `test/data-protection/` — the directory that task file grants it. `*.e2e-spec.ts` files in
  // the same folder are, as above, not matched by `testRegex` and run under `test/jest-e2e.json`
  // against the real database.
  roots: [
    '<rootDir>',
    '<rootDir>/../test/crypto',
    '<rootDir>/../test/auth',
    '<rootDir>/../test/security',
    '<rootDir>/../test/rbac',
    '<rootDir>/../test/common',
    '<rootDir>/../test/me',
    '<rootDir>/../test/data-protection',
    // T-018: same arrangement once more for `src/common/transport-crypto/**`, whose unit specs
    // live in `test/transport-crypto/` — the directory that task file grants it.
    // `transport-crypto.e2e-spec.ts` in the same folder is, as above, not matched by `testRegex`
    // and runs under `test/jest-e2e.json` against the real database.
    '<rootDir>/../test/transport-crypto',
    // T-019: same arrangement once more for `src/common/tracing/**` and
    // `src/common/logging/logger.module.ts`, whose unit specs live in `test/tracing/` — the
    // directory that task file grants it. `tracing.e2e-spec.ts` in the same folder is, as above,
    // not matched by `testRegex` and runs under `test/jest-e2e.json` against the real database.
    '<rootDir>/../test/tracing',
    // T-045: same arrangement once more for `src/modules/trace/**`, whose unit specs live in
    // `test/trace/` — the directory that task file grants it. `trace.e2e-spec.ts` in the same
    // folder is, as above, not matched by `testRegex` and runs under `test/jest-e2e.json` against
    // the real database.
    '<rootDir>/../test/trace',
    // T-030: same arrangement once more for `src/modules/countries/**`, whose unit specs live
    // in `test/countries/` — the directory that task file grants it.
    '<rootDir>/../test/countries',
    // T-040: same arrangement once more for `src/modules/notifications/**` and
    // `src/modules/audit/**`, whose unit specs live in `test/notifications/` and `test/audit/`
    // respectively — the directories that task file grants it. `*.e2e-spec.ts` files in either
    // folder are, as above, not matched by `testRegex` and run under `test/jest-e2e.json` against
    // the real database.
    '<rootDir>/../test/notifications',
    '<rootDir>/../test/audit',
    // T-031: same arrangement once more for `src/modules/rules/**`, whose unit specs live in
    // `test/rules/` — the directory that task file grants it. `rules.e2e-spec.ts` in the same
    // folder is, as above, not matched by `testRegex` and runs under `test/jest-e2e.json`
    // against the real database.
    '<rootDir>/../test/rules',
    // T-032: same arrangement once more for `src/modules/rewards/**`, whose unit specs live in
    // `test/rewards/` — the directory that task file grants it. `*.e2e-spec.ts` files in the
    // same folder are, as above, not matched by `testRegex` and run under `test/jest-e2e.json`
    // against the real database.
    '<rootDir>/../test/rewards',
    // T-033: same arrangement once more for `src/modules/access-control/**`, whose unit specs
    // live in `test/access-control/` — the directory that task file grants it.
    // `access-control.e2e-spec.ts` in the same folder is, as above, not matched by `testRegex`
    // and runs under `test/jest-e2e.json` against the real database.
    '<rootDir>/../test/access-control',
    // T-034: same arrangement once more for `src/modules/tenants/**`, whose unit specs live in
    // `test/tenants/` — the directory that task file grants it.
    '<rootDir>/../test/tenants',
    // T-035: same arrangement once more for `src/modules/users/**`, whose unit specs live in
    // `test/users/` — the directory that task file grants it.
    '<rootDir>/../test/users',
    // T-041: same arrangement once more for `src/modules/versions/**` and
    // `src/modules/blasts/**`, whose unit specs live in `test/versions/` and `test/blasts/`
    // respectively — the directories that task file grants it. `*.e2e-spec.ts` files in either
    // folder are, as above, not matched by `testRegex` and run under `test/jest-e2e.json`
    // against the real database.
    '<rootDir>/../test/versions',
    '<rootDir>/../test/blasts',
    // T-036: same arrangement once more for `src/modules/merchants/**`, whose unit specs live
    // in `test/merchants/` — the directory that task file grants it.
    '<rootDir>/../test/merchants',
    // T-042: same arrangement once more for `src/modules/definition-requests/**`, whose unit
    // specs live in `test/definition-requests/` — the directory that task file grants it.
    // `definition-requests.e2e-spec.ts` in the same folder is, as above, not matched by
    // `testRegex` and runs under `test/jest-e2e.json` against the real database.
    '<rootDir>/../test/definition-requests',
    // T-037: same arrangement once more for `src/modules/campaigns/**`, whose unit specs live in
    // `test/campaigns/` — the directory that task file grants it. `campaigns.e2e-spec.ts` in the
    // same folder is, as above, not matched by `testRegex` and runs under `test/jest-e2e.json`
    // against the real database.
    '<rootDir>/../test/campaigns',
    // T-038: same arrangement once more for `src/modules/approvals/**`, whose unit specs live in
    // `test/approvals/` — the directory that task file grants it. `approvals.e2e-spec.ts` in the
    // same folder is, as above, not matched by `testRegex` and runs under `test/jest-e2e.json`
    // against the real database.
    '<rootDir>/../test/approvals',
    // T-039: same arrangement once more for `src/modules/merchant-portal/**`, whose unit specs
    // live in `test/merchant-portal/` — the directory that task file grants it.
    // `merchant-portal.e2e-spec.ts` in the same folder is, as above, not matched by `testRegex`
    // and runs under `test/jest-e2e.json` against the real database.
    '<rootDir>/../test/merchant-portal',
    // T-047: same arrangement once more for `src/grpc/**`, whose unit specs live in
    // `test/grpc/` — the directory that task file grants it. `*.e2e-spec.ts` files in the same
    // folder are, as above, not matched by `testRegex` and run under `test/jest-e2e.json`
    // against the real database and a real mTLS listener.
    '<rootDir>/../test/grpc',
    // T-048: same arrangement once more for `src/modules/campaign-agent/**`, whose unit specs live
    // in `test/campaign-agent/` — the directory that task file grants it. `*.e2e-spec.ts` files in
    // the same folder are, as above, not matched by `testRegex` and run under `test/jest-e2e.json`
    // against the real database.
    '<rootDir>/../test/campaign-agent',
    // T-092: same arrangement once more for `src/modules/dashboard/**`, whose unit specs live in
    // `test/dashboard/` — the directory that task file grants it. `dashboard.e2e-spec.ts` in the
    // same folder is, as above, not matched by `testRegex` and runs under `test/jest-e2e.json`
    // against the real database.
    '<rootDir>/../test/dashboard',
    // T-121: same arrangement once more for `src/modules/field-value-sources/**`, whose unit
    // specs live in `test/field-value-sources/` — the directory that task file grants it.
    // `field-value-source-registries.e2e-spec.ts` in the same folder is, as above, not matched by
    // `testRegex` and runs under `test/jest-e2e.json` against the real database.
    '<rootDir>/../test/field-value-sources',
  ],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  coverageThreshold: {
    global: {
      lines: 0,
      statements: 0,
      branches: 0,
      functions: 0,
    },
    // T-016 — crypto core. Its own Definition of Done requires **100%** line and branch
    // coverage, not the 80% default: "a flaw here silently voids every other protection in
    // the system", so an untested branch here is an untested branch everywhere. Files matched
    // by a glob threshold are excluded from the `global` group above, so this is a real gate,
    // not an average that other files can dilute.
    './src/common/crypto/**/*.ts': {
      lines: 100,
      statements: 100,
      branches: 100,
      functions: 100,
    },
    // T-010 — the credential layer. Its Definition of Done also requires **100%** line and
    // branch coverage rather than the 80% default, because AGENT-PROTOCOL.md §4 puts auth
    // code in the same bracket as guards and scope: an untested branch in the login path is
    // an untested branch in the only thing standing between a stranger and every tenant's
    // data. Scoped to `modules/auth` so T-011/T-055 inherit the same bar as they add files.
    './src/modules/auth/**/*.ts': {
      lines: 100,
      statements: 100,
      branches: 100,
      functions: 100,
    },
    // T-012 — HTTP hardening. `CsrfGuard` and `RateLimitGuard` are guards, which AGENT-PROTOCOL
    // §4 puts at 100% rather than 80%; the header/CORS/HTTPS middleware sitting beside them is
    // held to the same bar because every one of its branches is a security decision (which
    // headers ship, which origin is echoed, whether a plaintext request is redirected).
    './src/common/security/**/*.ts': {
      lines: 100,
      statements: 100,
      branches: 100,
      functions: 100,
    },
    // T-013 — RBAC guards and the tenancy-scope layer. Its Definition of Done says **100%
    // coverage** without qualification, and AGENT-PROTOCOL §4 names "guards/scope/auth" as the
    // group held to 100% rather than 80%. This is the task the task file itself calls "the
    // highest-risk task in the project": an untested branch in `scopeWhere` is a tenant
    // boundary nobody has ever exercised.
    './src/common/rbac/**/*.ts': {
      lines: 100,
      statements: 100,
      branches: 100,
      functions: 100,
    },
    './src/common/scope/**/*.ts': {
      lines: 100,
      statements: 100,
      branches: 100,
      functions: 100,
    },
    // T-014 — audit, error normalisation, the message catalogue and log redaction. Its own
    // Definition of Done asks only for the 80% default, and this entry deliberately sets a
    // higher bar than it had to, for one reason: every branch in these four directories is a
    // decision about **what leaves the process**. An untested branch in
    // `error-normalization.filter.ts` is a response body nobody has ever looked at; an untested
    // branch in `redact.ts` is a log line nobody has ever read. Both were reached at 100% on
    // the first pass, so this pins what is already true rather than demanding new work.
    './src/common/audit/**/*.ts': {
      lines: 100,
      statements: 100,
      branches: 100,
      functions: 100,
    },
    './src/common/errors/**/*.ts': {
      lines: 100,
      statements: 100,
      branches: 100,
      functions: 100,
    },
    './src/common/messages/**/*.ts': {
      lines: 100,
      statements: 100,
      branches: 100,
      functions: 100,
    },
    './src/common/logging/**/*.ts': {
      lines: 100,
      statements: 100,
      branches: 100,
      functions: 100,
    },
    // T-015 — `/me`. Its own Definition of Done asks only for the 80% default, and this entry
    // deliberately sets a higher bar, for the reason T-014's entry above gives: every branch here
    // decides **what leaves the process** for the one call the entire SPA is built on. An untested
    // branch in `buildNavTree` is a menu nobody has ever rendered; an untested branch in
    // `ifNoneMatchSatisfiedBy` is a 304 served to a client whose permissions just changed; and
    // `me.service.ts` writes to `portal_users`, the table `role` lives in. All of it was reached
    // at 100% on the first pass, so this pins what is already true rather than demanding new work.
    './src/modules/me/**/*.ts': {
      lines: 100,
      statements: 100,
      branches: 100,
      functions: 100,
    },
    // T-017 — the data-protection engine. Its Definition of Done requires **100% coverage on
    // masking and serialisation**; this entry holds the whole module to that bar rather than the
    // two files, for the reason T-014's entry gives: every branch in this directory is a decision
    // about **what leaves the process**, or about what is written to a column that everything
    // else assumes is ciphertext. An untested branch in `policy.service.ts`'s fail-closed ladder
    // is a field somebody classified and nobody protected.
    //
    // `data-protection.module.ts` is the only exclusion, and the reason is mechanical rather
    // than a matter of taste: it imports `DatabaseModule` → `ConfigModule`, whose `validate`
    // runs at *import* time and calls `process.exit(1)` on an incomplete environment. A Jest
    // worker that imports it dies — observed while building this suite, not theorised — so it
    // cannot be unit-tested at all. Everything in it that *can* be moved somewhere testable has
    // been (`dataProtectionConfigFactory` now lives in `data-protection.config.ts`, at 100%);
    // what remains is the `@Module` decorator and two lifecycle hooks, exercised for real by
    // `data-protection.e2e-spec.ts` against the booted application.
    './src/common/data-protection/!(data-protection.module).ts': {
      lines: 100,
      statements: 100,
      branches: 100,
      functions: 100,
    },
    // T-018 — transport payload encryption. Its own Definition of Done asks for AGENT-PROTOCOL
    // §4's gates, and §4 puts crypto in the same bracket as guards and auth; this entry holds the
    // module to 100% for the reason T-016's entry gives about the at-rest half. An untested
    // branch in `payload-decrypt.interceptor.ts` is a request nobody has ever refused, and an
    // untested branch in `payload-encrypt.interceptor.ts` is a body nobody has ever looked
    // inside — which is precisely the failure TC-17 exists to catch.
    //
    // The two module files are excluded for the mechanical reason T-017's entry documents:
    // `transport-crypto.module.ts` imports `DataProtectionModule` → `DatabaseModule` →
    // `ConfigModule`, whose `validate` runs at *import* time and calls `process.exit(1)` on an
    // incomplete environment, so a Jest worker that imports it dies. Both are exercised for real
    // by `transport-crypto.e2e-spec.ts` against the booted application.
    './src/common/transport-crypto/!(*.module).ts': {
      lines: 100,
      statements: 100,
      branches: 100,
      functions: 100,
    },
    // T-019 — request tracing. Its own Definition of Done asks for AGENT-PROTOCOL §4's gates,
    // and this entry deliberately sets 100% rather than the 80% default, for two reasons that
    // are specific to this module rather than general enthusiasm:
    //
    //  1. `correlation.middleware.ts` validates an attacker-controlled header, and every branch
    //     of that validation is the difference between a rejected value and a forged log line
    //     (TC-4). `sql-comment.hook.ts` interpolates the result into a string that is *executed*.
    //     Both belong in the same bracket as the guards.
    //  2. `traceSpan` is now called from nine finished components across six completed tasks. An
    //     untested branch in it is an untested branch in all of them.
    //
    // `tracing.module.ts` is the only exclusion, for the mechanical reason T-017's and T-018's
    // entries document: it imports `DatabaseModule` → `ConfigModule`, whose `validate` runs at
    // *import* time and calls `process.exit(1)` on an incomplete environment, so a Jest worker
    // that imports it dies. It is exercised for real by `tracing.e2e-spec.ts`.
    './src/common/tracing/!(tracing.module).ts': {
      lines: 100,
      statements: 100,
      branches: 100,
      functions: 100,
    },
    // T-052 — health checks and metrics. `health.service.ts` decides `/health/ready`'s status
    // code (03-API-CONTRACT.md §14's "no dependency details" guarantee lives entirely in one
    // `try/catch` there) and `metrics.registry.ts`/`db-pool.sampler.ts` are the data structures
    // every rendered `/metrics` sample and TC-10/TC-11's port-isolation property rest on — the
    // same "an untested branch here is an untested branch everywhere it's used" reasoning
    // T-016/T-019's own entries give. `health.module.ts`/`metrics/metrics.module.ts` are
    // excluded for the same mechanical reason as every other `*.module.ts` entry above: a
    // `@Module` class body and a `configure()` one-liner are Nest wiring, not logic, and both
    // are exercised for real by every other module's own e2e boot (there is no dedicated
    // `health.e2e-spec.ts` — `test/security/route-inventory.e2e-spec.ts` and every other
    // e2e suite boot `AppModule`, which includes this one).
    './src/modules/health/!(*.module).ts': {
      lines: 100,
      statements: 100,
      branches: 100,
      functions: 100,
    },
    './src/modules/health/metrics/!(*.module).ts': {
      lines: 100,
      statements: 100,
      branches: 100,
      functions: 100,
    },
  },
  // T-019 — `src/common/logging/logger.module.ts` carries the same import-time `process.exit`
  // hazard as the module files excluded above, and for the same reason cannot be unit-tested.
  // `src/common/logging/**` already carries a 100% threshold (T-014's entry, for `redact.ts`), so
  // the exclusion has to be expressed here rather than as a threshold glob. `tracing.e2e-spec.ts`
  // covers it against the booted application.
  coveragePathIgnorePatterns: ['/node_modules/', 'src/common/logging/logger.module.ts'],
};
