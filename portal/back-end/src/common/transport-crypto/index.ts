/**
 * T-018 — public surface of transport payload encryption. Consumers import from
 * `@/common/transport-crypto`, never from an individual file.
 *
 * **Neither module is re-exported here**, for the reason `@/common/crypto`'s barrel gives:
 * `TransportCryptoModule` reaches `DataProtectionModule` → `DatabaseModule` → `ConfigModule`,
 * whose `validate` runs `validateEnv` at *import* time and calls `process.exit(1)` on an
 * incomplete environment. A barrel that reaches a `process.exit` is a barrel no unit test can
 * import. Wire the modules up with
 * `import { TransportCryptoModule } from '@/common/transport-crypto/transport-crypto.module'`
 * and `… from '@/common/transport-crypto/transport-handshake.module'`.
 */
export * from './handshake.service';
export * from './payload-decrypt.interceptor';
export * from './payload-encrypt.interceptor';
export * from './session-transport-key.repository';
export * from './transport-crypto.constants';
export * from './transport-crypto.exceptions';
export * from './transport-envelope';
export * from './transport-policy.service';
