import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * T-RTS-001 — TC-4, proven against a real process exit code rather than a mocked `process.exit`
 * spy (AGENT-PROTOCOL.md §3: "assert the observable property, not the implementation string").
 *
 * A plain `unset DB_HOST && npm run start:dev` cannot itself prove this contract, for two reasons
 * reward-redemption-service's own T-RR-004 review already found and documented (mirrored here
 * rather than rediscovered):
 *
 *   1. **The dev-convenience env file backfills the "unset" var.** `config.module.ts`'s
 *      `envFilePath` resolves, by default (`NODE_ENV` unset → falls back to `'development'`), to
 *      `.env.development` — which is checked in for local dev and already has `DB_HOST=localhost`
 *      populated. `@nestjs/config`'s own `ConfigModule.forRoot` merges as
 *      `{ ...fileConfig, ...process.env }`, so a variable *absent* from `process.env` (a
 *      shell-level `unset`) is silently supplied by the file.
 *   2. **`npm run start:dev` runs `nest start --watch`, and `--watch` mode never exits on a
 *      crashed child.** Even with (1) worked around, the wrapper process stays alive indefinitely
 *      after printing the "Invalid environment configuration" error — standard watch-mode
 *      behaviour, not a bug, but it also means "process exits non-zero" can never be observed via
 *      that script.
 *
 * This spec spawns a genuine one-shot (non-watch) `ts-node` subprocess (`fixtures/boot-check.ts`)
 * instead and asserts on its actual OS-level exit code and stderr.
 */
const SERVICE_ROOT = path.join(__dirname, '..', '..');
const TS_NODE_BIN = path.join(SERVICE_ROOT, 'node_modules', '.bin', 'ts-node');
const FIXTURE = path.join(__dirname, 'fixtures', 'boot-check.ts');

/** Every bootstrap var `config.schema.ts` requires, all valid — the control case. */
function fullValidEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    // Deliberately `test`, not `development`: no `.env.test` exists in this repo (only
    // `.env.development`/`.env.example` do), and no bare `.env` exists either, so
    // `config.module.ts`'s `envFilePath` fallback resolves to nothing here. Every var below is
    // therefore genuinely supplied by *this* subprocess's own `env`, never silently backfilled
    // from the checked-in dev file — the precise thing reason (1) above requires.
    NODE_ENV: 'test',
    DB_HOST: 'localhost',
    DB_NAME: 'reward_system',
    DB_APP_USERNAME: 'reward_tracking_app',
    DB_APP_PASSWORD: 'throwaway-local-dev-value',
    DB_MIGRATION_USERNAME: 'postgres',
    DB_MIGRATION_PASSWORD: 'throwaway-local-dev-value',
    KAFKA_BROKERS: 'localhost:9095',
  };
}

function runFixture(env: NodeJS.ProcessEnv) {
  return spawnSync(TS_NODE_BIN, ['-T', FIXTURE], {
    cwd: SERVICE_ROOT,
    env,
    encoding: 'utf8',
  });
}

describe('config bootstrap (real one-shot subprocess, TC-4)', () => {
  it('exits 0 against a fully-populated environment (control case)', () => {
    const result = runFixture(fullValidEnv());

    expect(result.status).toBe(0);
  }, 30_000);

  it('TC-4 — exits non-zero and names DB_HOST when it is genuinely absent', () => {
    const { DB_HOST: _omit, ...rest } = fullValidEnv();

    const result = runFixture(rest);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DB_HOST');
  }, 30_000);

  it('TC-4 — exits non-zero and names DB_SSL for a non-boolean value', () => {
    const result = runFixture({ ...fullValidEnv(), DB_SSL: 'maybe' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DB_SSL');
  }, 30_000);

  // Documents, and permanently guards, root cause (1) from this file's header: with `NODE_ENV`
  // left at its default (`development`) and run from this repo's own directory (where
  // `.env.development` really is checked in), an "unset" DB_HOST is NOT observable as a boot
  // failure — the file supplies it.
  it('documents: NODE_ENV=development + unset DB_HOST still boots, because .env.development backfills it', () => {
    const { NODE_ENV: _devEnv, DB_HOST: _omit, ...rest } = fullValidEnv();

    const result = runFixture(rest);

    expect(result.status).toBe(0);
  }, 30_000);
});
