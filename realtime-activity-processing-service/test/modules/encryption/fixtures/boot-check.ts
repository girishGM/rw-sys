/**
 * T-RAP-012. Not a Jest spec — a standalone script run in its own `ts-node` subprocess by
 * `boot.e2e-spec.ts`, specifically so TC-7 ("Boot with the encryption key env var unset → Process
 * exits non-zero at boot") is proven against a *real OS process exit code*, not a mocked
 * `process.exit` spy (AGENT-PROTOCOL.md §3: "assert the observable property, not the
 * implementation string").
 */
import 'reflect-metadata';
import { loadEncryptionKeyMaterial } from '../../../../src/modules/encryption/encryption.service';

try {
  loadEncryptionKeyMaterial();
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
