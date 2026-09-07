/**
 * T-RTS-001. Not a Jest spec — a standalone script run in its own `ts-node` subprocess by
 * `../config-boot.spec.ts`, specifically so TC-4 ("boot the app with a required env var unset") is
 * proven against a *real OS process exit code*, not a mocked `process.exit` spy
 * (`config.schema.spec.ts` already covers the in-process "throws naming the missing variable" half
 * of this same contract by calling `validateConfig()` directly) — mirrors
 * reward-redemption-service's own `src/config/fixtures/boot-check.ts` split between the two.
 *
 * Merely *importing* `../config.module` is enough to observe the real failure: `@Module({
 * imports: [NestConfigModule.forRoot({ validate: validateConfig, ... })] })` evaluates its
 * decorator argument at class-definition time, and `ConfigModule.forRoot` runs synchronously up to
 * (and including) the `validate(...)` call before its first `await` — so a bad environment calls
 * `process.exit(1)` here without this script ever needing to boot the full Nest application.
 */
import 'reflect-metadata';
import '../config.module';

process.exit(0);
