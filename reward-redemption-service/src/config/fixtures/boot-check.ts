/**
 * T-RR-004 (retry 1, post-review fix). Not a Jest spec — a standalone script run in its own
 * `ts-node` subprocess by `../config-boot.spec.ts`, specifically so TC-1/TC-2 ("boot with a
 * required env var unset/malformed" / "boot with `DB_SSL` set to a non-boolean string") are
 * proven against a *real OS process exit code*, not a mocked `process.exit` spy
 * (`config.schema.spec.ts` already covers the in-process "throws naming the missing variable"
 * half of this same contract by calling `validateConfig()` directly — mirrors RAP's own
 * `test/modules/encryption/fixtures/boot-check.ts` split between the two).
 *
 * Merely *importing* `../config.module` is enough to observe the real failure: `@Module({
 * imports: [NestConfigModule.forRoot({ validate: validateConfig, ... })] })` evaluates its
 * decorator argument at class-definition time, and `ConfigModule.forRoot` runs synchronously
 * up to (and including) the `validate(...)` call before its first `await` — so a bad
 * environment calls `process.exit(1)` here without this script ever needing to boot the full
 * Nest application. See `../config-boot.spec.ts`'s header for why this must run as a one-shot
 * process (not `nest start --watch`) and with `NODE_ENV=test` (not the default `development`).
 */
import 'reflect-metadata';
import '../config.module';

process.exit(0);
