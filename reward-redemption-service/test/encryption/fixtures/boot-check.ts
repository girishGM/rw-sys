/**
 * T-RR-005. Not a Jest spec — a standalone script run in its own `ts-node` subprocess by
 * `../boot.e2e-spec.ts`, specifically so TC-5/TC-6 ("boot with a `FIELD_ENCRYPTION_*` env var
 * unset/malformed → process exits non-zero") are proven against a *real OS process exit code*, not
 * a mocked `process.exit` spy (`encryption.service.spec.ts` and `encryption.module.spec.ts`
 * already cover the in-process "throws"/"rejects" halves of this same contract — see
 * `AGENT-PROTOCOL.md` §3: "assert the observable property, not the implementation string").
 *
 * Compiles just `ConfigModule` + `EncryptionModule` (not the full `AppModule`, which would go on
 * to call `app.listen(...)` in the success case and never exit on its own) — `EncryptionModule`'s
 * own factory provider throws synchronously inside `.compile()` on a missing/malformed key, the
 * same mechanism that fires when `AppModule` is compiled for real (`app.module.ts`'s own header).
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '../../../src/config/config.module';
import { EncryptionModule } from '../../../src/modules/encryption/encryption.module';

async function run(): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, EncryptionModule],
  }).compile();
  await moduleRef.close();
}

run()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
