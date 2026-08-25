/**
 * Runs once before every e2e test file. e2e tests boot real Nest modules (including
 * ConfigModule's fail-fast env validation), so — unlike unit tests, which never construct
 * that module — they need real connection details.
 *
 * Jest sets `NODE_ENV=test` automatically, and this project has no `.env.test` (there's
 * no separate test database provisioned yet — same real local Postgres instance as dev,
 * per the T-001/T-002 completion reports). `.env.development` is loaded explicitly here
 * rather than relying on `NODE_ENV`-based file selection, which is exactly what silently
 * broke this the first time (found by actually running the suite, not by inspection).
 *
 * CI (T-052) sets real environment variables directly rather than shipping a `.env` file;
 * `dotenv.config()` never overwrites a variable already present in `process.env`, so this
 * is a safe no-op there.
 */
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env.local'), quiet: true });
dotenv.config({ path: path.join(__dirname, '..', '.env.development'), quiet: true });
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });
