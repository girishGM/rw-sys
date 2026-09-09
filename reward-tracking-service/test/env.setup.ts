/**
 * T-RTS-001. Runs before every test file (Jest `setupFiles`, registered in `package.json`). Loads
 * `.env.development` into `process.env` so `cd reward-tracking-service && npm test` — the exact,
 * documented AGENT-PROTOCOL.md §4 gate, run from a clean shell with nothing pre-exported — actually
 * passes.
 *
 * Without this, `ConfigModule.forRoot({ validate: validateConfig })` (evaluated synchronously at
 * `AppModule`'s own static import time, `config.module.ts`'s header) would `process.exit(1)` on a
 * bare `npm test` — the identical gap reward-redemption-service's own `test/database/env.setup.ts`
 * fixed after independent review caught it there; applied here from day one instead.
 *
 * `dotenv.config()` never overwrites a variable already present in `process.env`, so a real
 * CI/deployment environment value always wins over this file's own `.env.development` contents.
 */
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env.local'), quiet: true });
dotenv.config({ path: path.join(__dirname, '..', '.env.development'), quiet: true });
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });
