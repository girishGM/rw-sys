import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * T-RR-004, retry 1 — added directly in response to an independent review failure against this
 * task's own manual "Verification step 1" (`cd reward-redemption-service && unset DB_HOST &&
 * npm run start:dev`, expecting a non-zero exit naming `DB_HOST`). That step, run exactly as
 * written, does NOT observe the documented outcome, for two independently-confirmed reasons —
 * neither of which is a defect in `validateConfig`/`config.schema.ts` itself (already proven
 * correct in isolation by `config.schema.spec.ts`):
 *
 *   1. **The dev-convenience env file backfills the "unset" var.** `config.module.ts`'s
 *      `envFilePath` resolves, by default (`NODE_ENV` unset → falls back to `'development'`), to
 *      `.env.development` — which is checked in for local dev and already has `DB_HOST=localhost`
 *      populated. `@nestjs/config`'s own `ConfigModule.forRoot` merges as
 *      `{ ...fileConfig, ...process.env }` (`node_modules/@nestjs/config/dist/config.module.js`),
 *      so a variable *absent* from `process.env` (a shell-level `unset`) is silently supplied by
 *      the file — only a variable *present* in `process.env` (even as `''`) would ever win over
 *      it. A plain `unset DB_HOST` is therefore indistinguishable, from this merge's point of
 *      view, from "rely on the checked-in dev file" — which is exactly what verification step 2
 *      of this same task intends `npm run start:dev` to do.
 *   2. **`npm run start:dev` runs `nest start --watch`, and `--watch` mode never exits on a
 *      crashed child.** Confirmed empirically (spawned, waited 15s): even once (1) above is
 *      worked around (e.g. `NODE_ENV=test`, which has no matching `.env.test` file), the
 *      `nest start --watch` wrapper process stays alive indefinitely after printing the
 *      "Invalid environment configuration" error and idles waiting for a file-save to retry — it
 *      never itself terminates, let alone with a non-zero code. This is standard, deliberate
 *      watch-mode/nodemon-style behavior (so a developer can fix a typo without manually
 *      restarting the watcher), not a bug — but it also means "process exits non-zero" can never
 *      be observed via the `--watch` script, independent of (1) entirely.
 *
 * Because of both, this contract cannot be proven by a manual `npm run start:dev` terminal
 * session at all — it can only be proven against a genuine one-shot (non-watch) process, which is
 * exactly what this file does, mirroring RAP's own `test/modules/encryption/boot.e2e-spec.ts`
 * pattern: spawn a real `ts-node` subprocess (`fixtures/boot-check.ts`) and assert on its actual
 * OS-level exit code and stderr, not a mocked `process.exit` spy
 * (AGENT-PROTOCOL.md §3: "assert the observable property, not the implementation string"). The
 * corrected, literally-reproducible equivalent of the task file's own verification step 1 is:
 *
 *   cd reward-redemption-service
 *   env -u DB_HOST NODE_ENV=test GRPC_SERVER_TLS_CA_PATH=/tmp/ca.pem \
 *     GRPC_SERVER_TLS_CERT_PATH=/tmp/cert.pem GRPC_SERVER_TLS_KEY_PATH=/tmp/key.pem \
 *     GRPC_SERVER_ALLOWED_IDENTITIES=rap-ingest-client:1 DB_NAME=reward_system \
 *     DB_APP_USERNAME=rr_app DB_APP_PASSWORD=x DB_MIGRATION_USERNAME=postgres \
 *     DB_MIGRATION_PASSWORD=x KAFKA_BROKERS=localhost:9094 \
 *     ./node_modules/.bin/ts-node -T -r tsconfig-paths/register src/main.ts
 *
 * which prints exactly `Invalid environment configuration:\n  - DB_HOST: Required` and exits 1 —
 * see the completion report for the actual terminal transcript. This spec file automates that
 * same one-shot reproduction so the contract is enforced by `npm test` going forward, rather than
 * depending on a human re-deriving the `NODE_ENV=test` / non-watch nuance correctly by hand every
 * time.
 */
const SERVICE_ROOT = path.join(__dirname, '..', '..');
const TS_NODE_BIN = path.join(SERVICE_ROOT, 'node_modules', '.bin', 'ts-node');
const FIXTURE = path.join(__dirname, 'fixtures', 'boot-check.ts');

/** Every bootstrap var `config.schema.ts` requires, all valid — the control case. */
function fullValidEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    // Deliberately `test`, not `development`: `.env.test` does not exist in this repo (only
    // `.env.development`/`.env.example` do — confirmed by `ls`), and no bare `.env` exists
    // either, so `config.module.ts`'s `envFilePath` fallback resolves to nothing here. Every var
    // below is therefore genuinely supplied by *this* subprocess's own `env`, never silently
    // backfilled from the checked-in dev file — the precise thing reason (1) above requires.
    NODE_ENV: 'test',
    GRPC_SERVER_TLS_CA_PATH: '/tmp/ca.pem',
    GRPC_SERVER_TLS_CERT_PATH: '/tmp/cert.pem',
    GRPC_SERVER_TLS_KEY_PATH: '/tmp/key.pem',
    GRPC_SERVER_ALLOWED_IDENTITIES: 'rap-ingest-client:1',
    DB_HOST: 'localhost',
    DB_NAME: 'reward_system',
    DB_APP_USERNAME: 'rr_app',
    DB_APP_PASSWORD: 'throwaway-local-dev-value',
    DB_MIGRATION_USERNAME: 'postgres',
    DB_MIGRATION_PASSWORD: 'throwaway-local-dev-value',
    KAFKA_BROKERS: 'localhost:9094',
  };
}

function runFixture(env: NodeJS.ProcessEnv) {
  return spawnSync(TS_NODE_BIN, ['-T', FIXTURE], {
    cwd: SERVICE_ROOT,
    env,
    encoding: 'utf8',
  });
}

describe('config bootstrap (real one-shot subprocess, TC-1/TC-2)', () => {
  it('exits 0 against a fully-populated environment (control case)', () => {
    const result = runFixture(fullValidEnv());

    expect(result.status).toBe(0);
  }, 30_000);

  // TC-1, proven against a real process exit code — the actual gap the independent review found:
  // no prior test proved the *whole* dotenv-load-then-validate chain end to end, only the pure
  // `validateConfig()` function in isolation.
  it('TC-1 — exits non-zero and names DB_HOST when it is genuinely absent', () => {
    const { DB_HOST: _omit, ...rest } = fullValidEnv();

    const result = runFixture(rest);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DB_HOST');
  }, 30_000);

  it('TC-2 — exits non-zero and names DB_SSL for a non-boolean value', () => {
    const result = runFixture({ ...fullValidEnv(), DB_SSL: 'maybe' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DB_SSL');
  }, 30_000);

  // Documents, and permanently guards, root cause (1) from this file's header: with `NODE_ENV`
  // left at its default (`development`) and run from this repo's own directory (where
  // `.env.development` really is checked in), an "unset" DB_HOST is NOT observable as a boot
  // failure — the file supplies it. If this ever starts failing, either `.env.development` lost
  // its `DB_HOST` line or `config.module.ts`'s envFilePath/merge behavior changed; either way,
  // verification step 1's own literal wording (`unset DB_HOST && npm run start:dev`) would once
  // again need re-checking against this file's header before trusting a "successful" manual repro
  // — or, symmetrically, before trusting a "failed" one.
  it('documents: NODE_ENV=development + unset DB_HOST still boots, because .env.development backfills it', () => {
    const { NODE_ENV: _devEnv, DB_HOST: _omit, ...rest } = fullValidEnv();

    const result = runFixture(rest);

    expect(result.status).toBe(0);
  }, 30_000);
});
