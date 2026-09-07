import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * T-RR-005. TC-5/TC-6 ("boot with `FIELD_ENCRYPTION_AES_KEY`/`FIELD_ENCRYPTION_HMAC_KEY`
 * unset/malformed → process exits non-zero, error names the offending var"), proven against a
 * real, separately-spawned `ts-node` subprocess — the only way to observe an actual OS-level
 * non-zero exit code, mirroring both RAP's own
 * `test/modules/encryption/boot.e2e-spec.ts` and this service's own established precedent
 * (`src/config/config-boot.spec.ts`, T-RR-004) for the identical "a manual `npm run start:dev`
 * cannot show this" reasoning: `nest start --watch` never terminates on a crashed child, so this
 * task's own Verification step 3 (`unset FIELD_ENCRYPTION_AES_KEY && npm run start:dev`) is
 * reproduced here instead as a genuine one-shot (non-watch) process — see
 * `fixtures/boot-check.ts` for the script this spawns, and `src/config/config-boot.spec.ts`'s own
 * header for the fuller writeup of why a `--watch` reproduction can never observe this contract.
 */
const SERVICE_ROOT = path.join(__dirname, '..', '..');
const TS_NODE_BIN = path.join(SERVICE_ROOT, 'node_modules', '.bin', 'ts-node');
const FIXTURE = path.join(__dirname, 'fixtures', 'boot-check.ts');

const AES_KEY_B64 = Buffer.alloc(32, 1).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 2).toString('base64');

/** Every bootstrap var `config.schema.ts` requires, all valid — the control case. Deliberately
 * `NODE_ENV=test` (no matching `.env.test` file exists in this repo), so nothing here is silently
 * backfilled from the checked-in `.env.development` — same reasoning `config-boot.spec.ts`'s own
 * `fullValidEnv()` already documents. */
function fullValidEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
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
    FIELD_ENCRYPTION_AES_KEY: AES_KEY_B64,
    FIELD_ENCRYPTION_HMAC_KEY: HMAC_KEY_B64,
  };
}

function runFixture(env: NodeJS.ProcessEnv) {
  return spawnSync(TS_NODE_BIN, ['-T', FIXTURE], {
    cwd: SERVICE_ROOT,
    env,
    encoding: 'utf8',
  });
}

describe('encryption boot-check fixture (real subprocess, TC-5/TC-6)', () => {
  it('exits 0 against a fully-populated environment (control case)', () => {
    const result = runFixture(fullValidEnv());

    expect(result.status).toBe(0);
  }, 30_000);

  // TC-5.
  it('exits non-zero and names FIELD_ENCRYPTION_AES_KEY when it is unset', () => {
    const { FIELD_ENCRYPTION_AES_KEY: _omit, ...rest } = fullValidEnv();

    const result = runFixture(rest);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FIELD_ENCRYPTION_AES_KEY');
  }, 30_000);

  it('exits non-zero and names FIELD_ENCRYPTION_HMAC_KEY when it is unset', () => {
    const { FIELD_ENCRYPTION_HMAC_KEY: _omit, ...rest } = fullValidEnv();

    const result = runFixture(rest);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FIELD_ENCRYPTION_HMAC_KEY');
  }, 30_000);

  // TC-6.
  it('exits non-zero and names the byte-length violation when FIELD_ENCRYPTION_AES_KEY is too short', () => {
    const result = runFixture({
      ...fullValidEnv(),
      FIELD_ENCRYPTION_AES_KEY: Buffer.alloc(16, 1).toString('base64'),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('32 bytes');
  }, 30_000);
});
