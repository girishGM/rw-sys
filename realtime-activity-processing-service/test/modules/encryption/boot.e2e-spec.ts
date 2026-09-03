/**
 * T-RAP-012. TC-7 ("Boot with the encryption key env var unset → Process exits non-zero at
 * boot"), proven against a real, separately-spawned `ts-node` process — the only way to observe
 * an actual OS-level non-zero exit code rather than a mocked `process.exit` spy
 * (`encryption.service.spec.ts` already covers the in-process "throws naming the missing
 * variable" half of this same contract). See `fixtures/boot-check.ts` for the script this spawns.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SERVICE_ROOT = join(__dirname, '..', '..', '..');
const TS_NODE_BIN = join(SERVICE_ROOT, 'node_modules', '.bin', 'ts-node');
const FIXTURE = join(__dirname, 'fixtures', 'boot-check.ts');

const AES_KEY_B64 = Buffer.alloc(32, 1).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 2).toString('base64');

function runFixture(env: NodeJS.ProcessEnv) {
  return spawnSync(TS_NODE_BIN, ['-T', FIXTURE], {
    cwd: SERVICE_ROOT,
    env,
    encoding: 'utf8',
  });
}

describe('boot-check fixture (real subprocess, TC-7)', () => {
  it('exits non-zero and names the missing variable when FIELD_ENCRYPTION_AES_KEY is unset', () => {
    const { FIELD_ENCRYPTION_AES_KEY: _omit, ...rest } = process.env;
    const result = runFixture({ ...rest, FIELD_ENCRYPTION_HMAC_KEY: HMAC_KEY_B64 });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FIELD_ENCRYPTION_AES_KEY');
  }, 30_000);

  it('exits non-zero and names the missing variable when FIELD_ENCRYPTION_HMAC_KEY is unset', () => {
    const { FIELD_ENCRYPTION_HMAC_KEY: _omit, ...rest } = process.env;
    const result = runFixture({ ...rest, FIELD_ENCRYPTION_AES_KEY: AES_KEY_B64 });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FIELD_ENCRYPTION_HMAC_KEY');
  }, 30_000);

  it('exits 0 when both keys are valid', () => {
    const result = runFixture({
      ...process.env,
      FIELD_ENCRYPTION_AES_KEY: AES_KEY_B64,
      FIELD_ENCRYPTION_HMAC_KEY: HMAC_KEY_B64,
    });

    expect(result.status).toBe(0);
  }, 30_000);
});
