/**
 * T-016 — public surface of the crypto core. Consumers (T-010, T-017, T-018) import from
 * `@/common/crypto`, never from an individual file, so the internal layout can change
 * without a cross-task edit.
 *
 * **`CryptoModule` is deliberately not re-exported here.** Importing it pulls in
 * `DatabaseModule` → `ConfigModule`, and `ConfigModule.forRoot({ validate })` runs
 * `validateEnv` at *import* time — which calls `process.exit(1)` when the environment is
 * incomplete. A barrel that reaches a `process.exit` is a barrel no unit test can import,
 * and these are the unit tests that have to reach 100% branch coverage. The same split
 * already exists elsewhere in this codebase: `src/database/models/index.ts` exports models,
 * not `DatabaseModule`. Wire the module up with
 * `import { CryptoModule } from '@/common/crypto/crypto.module'`.
 */
export * from './blind-index.service';
export * from './ciphertext';
export * from './crypto.errors';
export * from './field-crypto.service';
export * from './key-material.resolver';
export * from './key-registry.service';
export * from './rotate-keys.command';
