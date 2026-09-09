/**
 * T-RR-050. Fixes: `npm run start:dev` / `node dist/main.js`, run from a genuinely clean shell
 * with nothing pre-exported, crashed during Nest bootstrap even though every var it needed was
 * present in `.env.development`.
 *
 * **Root cause.** `@nestjs/config`'s own `ConfigModule.forRoot({ validate, envFilePath })`
 * (`config.module.ts`) loads the dotenv files named by `envFilePath` (via `env-file-names.ts`)
 * into a local, in-memory object, validates it through `config.schema.ts`'s Zod schema, and then
 * calls `assignVariablesToProcess(validatedConfig)` — copying only the VALIDATED, schema-whitelisted
 * subset of that merged object back onto `process.env`
 * (`node_modules/@nestjs/config/dist/config.module.js`). Any variable that exists only in a dotenv
 * file and is outside that Zod schema — by design; see `config.schema.ts`'s own header —
 * `FIELD_ENCRYPTION_AES_KEY`/`FIELD_ENCRYPTION_HMAC_KEY` (`encryption.service.ts`),
 * `CACHE_ADMIN_TOKEN` (`cache-admin-token.ts`), and any later-wave bearer token/`PORTAL_GRPC_*`
 * var — is genuinely never written to `process.env` at runtime. Its own module then reads
 * `process.env.THAT_VAR`, gets `undefined`, and throws.
 *
 * This was pre-existing since T-RR-005 (the first module to read a var this way) and stayed
 * invisible because `test/database/env.setup.ts` loads the same files directly into `process.env`
 * *before* Jest ever imports `ConfigModule`, masking the gap everywhere `npm test` looks. Only a
 * real, separately-spawned process that never goes through that Jest setup file — exactly
 * `npm run start:dev`/`node dist/main.js`, and now this task's own regression test,
 * `test/encryption/real-main-boot.e2e-spec.ts` — can observe it.
 *
 * **The fix.** Eagerly `dotenv.config()` the same three files (`env-file-names.ts` — same
 * precedence `config.module.ts` itself uses) directly into `process.env`, mirroring
 * `env.setup.ts`'s own already-proven approach, before `main.ts` ever imports `AppModule`/
 * `ConfigModule`. `dotenv.config()` never overwrites a key already present in `process.env`, so a
 * real deployment-supplied env var still always wins over any of these files' contents — this
 * changes nothing about precedence for a var already reachable today, it only adds the vars that
 * previously fell through the gap. `config.schema.ts`'s own deliberate Wave-0/later-wave file-scope
 * boundary (documented in its header) is left exactly as-is: this is the "main.ts should eagerly
 * dotenv.config() the real files" option from this task's own filed evidence, not the alternative
 * of folding those vars into the Zod schema — chosen specifically because it needs zero changes to
 * that boundary or to any later-wave task's own env var.
 *
 * **Call this from the very first line of every standalone entry point's source** (`main.ts` now;
 * the gRPC/Kafka bootstrap files T-RR-011/T-RR-012 add in Wave 1), before anything else is
 * imported — see `main.ts`'s own header for why import *position*, not just call position, matters
 * here (`ConfigModule.forRoot(...)` runs synchronously the moment `config.module.ts` itself is
 * `require`'d, not merely once `NestFactory.create` is later called).
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { getEnvFileNames } from './env-file-names';

export function loadDotenvFilesIntoProcessEnv(): void {
  const serviceRoot = path.join(__dirname, '..', '..');
  for (const fileName of getEnvFileNames()) {
    dotenv.config({ path: path.join(serviceRoot, fileName), quiet: true });
  }
}
