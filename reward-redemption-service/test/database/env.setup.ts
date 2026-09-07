/**
 * T-RR-004. Runs before every test file (Jest `setupFiles`, registered in `package.json`'s own
 * `jest.setupFiles` array — order there is significant, this file must run before any test
 * file's own static imports are evaluated). Loads `.env.development` into `process.env` so
 * `cd reward-redemption-service && npm test` — the exact, documented AGENT-PROTOCOL.md §4 gate,
 * run from a clean shell with nothing pre-exported — actually passes.
 *
 * Without this, both `migration-connection.ts` (read directly via `requireEnv`, its own header
 * explains why it bypasses `config.schema.ts`) and, as of this task, `ConfigModule.forRoot({
 * validate: validateConfig })` (evaluated synchronously at `AppModule`'s own static import time,
 * `config.module.ts`'s header) throw/`process.exit(1)` on a bare `npm test` — this is exactly
 * the gap independent review caught against T-RR-002 and T-RR-003's own completion reports
 * ("test (N/N passed)" was only true given inherited shell env vars, not the documented gate as
 * actually run) and RAP's own `test/database/env.setup.ts` fixed first for the identical reason.
 *
 * `dotenv.config()` never overwrites a variable already present in `process.env`, so a real
 * CI/deployment environment value always wins over this file's own `.env.development` contents.
 */
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local'), quiet: true });
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.development'), quiet: true });
dotenv.config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
