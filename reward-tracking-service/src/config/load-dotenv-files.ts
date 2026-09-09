/**
 * T-RTS-001, applying reward-redemption-service's own T-RR-050 fix from day one instead of
 * rediscovering the same bug: `npm run start:dev` / `node dist/main.js`, run from a genuinely
 * clean shell with nothing pre-exported, would otherwise crash during Nest bootstrap even though
 * every var it needs is present in `.env.development`.
 *
 * **Root cause (as found in reward-redemption-service, and pre-empted here).**
 * `@nestjs/config`'s own `ConfigModule.forRoot({ validate, envFilePath })` (`config.module.ts`)
 * loads the dotenv files named by `envFilePath` (via `env-file-names.ts`) into a local, in-memory
 * object, validates it through `config.schema.ts`'s Zod schema, and then copies only the
 * VALIDATED, schema-whitelisted subset of that merged object back onto `process.env`. Any
 * variable that exists only in a dotenv file and is outside that Zod schema — by design, see
 * `config.schema.ts`'s own header — is genuinely never written to `process.env` at runtime. A
 * later-wave module that reads `process.env.THAT_VAR` directly then gets `undefined`.
 *
 * **The fix.** Eagerly `dotenv.config()` the same three files (`env-file-names.ts` — same
 * precedence `config.module.ts` itself uses) directly into `process.env`, before `main.ts` ever
 * imports `AppModule`/`ConfigModule`. `dotenv.config()` never overwrites a key already present in
 * `process.env`, so a real deployment-supplied env var still always wins over any of these files'
 * contents — this changes nothing about precedence for a var already reachable today, it only adds
 * the vars that would otherwise fall through the gap once a Wave 1+ module starts reading one
 * directly.
 *
 * **Call this from the very first line of every standalone entry point's source** (`main.ts` now;
 * a future gRPC/Kafka bootstrap file in Wave 1 adds its own), before anything else is imported —
 * see `main.ts`'s own header for why import *position*, not just call position, matters here
 * (`ConfigModule.forRoot(...)` runs synchronously the moment `config.module.ts` itself is
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
