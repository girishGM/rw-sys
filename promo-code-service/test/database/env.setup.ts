/**
 * Runs before every test file (Jest `setupFiles`, registered ahead of `test/jest-e2e.setup.ts`
 * in `package.json`'s own `jest.setupFiles` array — order there is significant). This suite
 * (`migrations.spec.ts`) needs real, authenticated Postgres credentials — the migration role's
 * real password, and the `promo_code_app` password this service's own migration sets the role
 * to — not `jest-e2e.setup.ts`'s throwaway placeholder defaults, which only exist to keep
 * `test/health.e2e-spec.ts`'s unauthenticated TCP-reachability check working.
 *
 * `.env.development` is loaded explicitly here rather than relying on `NODE_ENV`-based file
 * selection (this project has no `.env.test` — same real local Postgres instance as dev, per
 * the T-PC-001/T-PC-002 completion reports; portal/back-end's own `test/jest-e2e.setup.ts` hit
 * this exact same "no NODE_ENV-based file, load .env.development directly" fix first).
 * `dotenv.config()` never overwrites a variable already present in `process.env`, so a real
 * CI/environment value always wins over this file.
 */
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local'), quiet: true });
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.development'), quiet: true });
dotenv.config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
