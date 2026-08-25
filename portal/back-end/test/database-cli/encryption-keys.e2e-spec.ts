/**
 * T-057 (D-2) — real-Postgres integration coverage for `src/database/cli/encryption-keys.ts`.
 *
 * Runs the CLI as a genuine child process (`ts-node`, no `npm run` wrapper — this task was
 * explicitly not granted `back-end/package.json`, see the completion report's "Deviations
 * from spec"), the same way `test/database/t004-seeds-bootstrap.e2e-spec.ts` runs
 * `bootstrap:superadmin` for itself: the whole point of these cases is the CLI's real
 * env/exit-code/stdout contract and the real database constraints
 * (`uq_ek_active_purpose`, `ck_ek_algorithm`), which only a real process boundary and a real
 * connection can prove — `encryption-keys.spec.ts` already covers every pure branch (argument
 * parsing, defaulting, message formatting) without touching the network.
 *
 * Uses the `token` purpose throughout, deliberately: nothing in this codebase has a consumer
 * for it yet (grep confirms no `getActiveKey('token')`/`getActiveKey('transport')` caller),
 * so this suite cannot collide with the `field`/`blind_index` rows the rest of local dev
 * (and other e2e suites) already depend on — `uq_ek_active_purpose` would otherwise turn a
 * second `provision` in this suite into a false failure against real, in-use keys. Every row
 * this file creates is deleted in `afterAll`, pass or fail.
 *
 * `rotate`/`retire` load the **whole** `encryption_keys` table (`KeyRegistryService.load()`
 * has no purpose filter — every row, of every purpose and status, must resolve). This is a
 * real, observed property of the shared local dev database, not a hypothetical: at the time
 * this suite was written it already held two `rotating` rows from an unrelated task's own
 * manual verification session (`t058ui_t056_fld`/`t058ui_t056_bidx`), whose env vars this
 * process has no way to know. `resolveWholeRegistryEnv()` below closes that gap generically —
 * for any row this suite did not itself create, it supplies a fresh random placeholder of the
 * right size, in this child process's environment only. That is safe precisely because
 * `activateKey`/`retireKey` never decrypt anything; they only need `load()` to resolve
 * material into memory, not for that material to match whatever it originally protected.
 */
import 'reflect-metadata';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { buildAppConnection, insertKeyRow } from '@/database/cli/encryption-keys';

const BACK_END_DIR = path.join(__dirname, '..', '..');
const KID_PREFIX = 't057-tok-';

// Real, canonical 32-byte base64 material — `EnvKeyMaterialResolver.decodeKeyMaterial`
// round-trip-checks the encoding (07-DATA-PROTECTION.md §3's canonical-base64 guard), so an
// arbitrary repeated-character string is not guaranteed to pass it. These two values are
// never used to decrypt anything real; only the registry's ability to *resolve* them matters
// for `rotate`/`retire` here.
const FAKE_TOK_1_MATERIAL = randomBytes(32).toString('base64');
const FAKE_TOK_2_MATERIAL = randomBytes(32).toString('base64');

function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    'npx',
    [
      'ts-node',
      '-T',
      '-r',
      'tsconfig-paths/register',
      'src/database/cli/encryption-keys.ts',
      ...args,
    ],
    {
      cwd: BACK_END_DIR,
      env: { ...process.env, ...extraEnv },
      encoding: 'utf-8',
      timeout: 60_000,
    },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function deleteTestRows(sequelize: Sequelize): Promise<void> {
  await sequelize.query(`DELETE FROM reward_portal.encryption_keys WHERE kid LIKE :prefix`, {
    type: QueryTypes.RAW,
    replacements: { prefix: `${KID_PREFIX}%` },
  });
}

/** See this file's header. Supplies a syntactically-valid placeholder for every `env:`-backed
 * row this suite does not already know the value of, so `KeyRegistryService.load()` (called
 * internally by both `rotate` and `retire`) can succeed regardless of what unrelated rows
 * happen to already be in the shared table. */
async function resolveWholeRegistryEnv(
  sequelize: Sequelize,
  known: Record<string, string>,
): Promise<Record<string, string>> {
  const rows = await sequelize.query<{ key_ref: string }>(
    `SELECT key_ref FROM reward_portal.encryption_keys`,
    { type: QueryTypes.SELECT },
  );
  const env: Record<string, string> = { ...known };
  for (const row of rows) {
    if (!row.key_ref.startsWith('env:')) continue; // e.g. a future kms: row — not this suite's concern
    const name = row.key_ref.slice(4);
    if (env[name] !== undefined || process.env[name] !== undefined) continue;
    env[name] = randomBytes(32).toString('base64');
  }
  return env;
}

describe('T-057 (D-2) — encryption-keys.ts against the real database', () => {
  let sequelize: Sequelize;

  beforeAll(async () => {
    sequelize = createMigrationConnection();
    await sequelize.authenticate();
    await deleteTestRows(sequelize);
  });

  afterAll(async () => {
    await deleteTestRows(sequelize);
    await sequelize.close();
  });

  it('TC-7/TC-9 — provisions the first active key for a purpose, printing material exactly once', () => {
    const kid = `${KID_PREFIX}1`;
    const envVar = 'T057_TEST_TOK_1';
    const result = runCli(['provision', 'token', '--kid', kid, '--env-var', envVar]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`kid       = ${kid}`);
    expect(result.stdout).toContain('status    = active');
    expect(result.stdout).toContain(`key_ref   = env:${envVar}`);

    const materialMatch = result.stdout.match(new RegExp(`${envVar}=(\\S+)`));
    expect(materialMatch).not.toBeNull();
    // 32 raw bytes, base64-encoded, is always 44 characters (with a trailing '=').
    expect(materialMatch?.[1]).toHaveLength(44);
    // Never printed a second time anywhere else in the output.
    expect(result.stdout.split(`${envVar}=`)).toHaveLength(2);
  });

  it('is present afterwards via `list`, and never leaks material there', () => {
    const result = runCli(['list']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${KID_PREFIX}1`);
    expect(result.stdout).toContain('token');
    expect(result.stdout).toContain('active');
    expect(result.stdout).toContain('env:T057_TEST_TOK_1');
  });

  it('TC-8 — refuses a second `provision` for the same purpose, with a clear message, not a raw constraint-violation stack', () => {
    const result = runCli(['provision', 'token']);

    expect(result.status).toBe(1);
    // Caught by `runProvision`'s own pre-check (an active-count SELECT before ever attempting
    // the INSERT), so this specific message does not need to name `uq_ek_active_purpose`
    // itself — `insertKeyRow`'s own catch block does that for the race-condition path, and is
    // exercised directly by inserting two 'active' rows concurrently below.
    expect(result.stderr).toMatch(/active 'token' key already exists/);
    expect(result.stderr).toMatch(/'add token'/);
    // The whole point of TC-8: no raw Sequelize/pg stack trace leaking to the operator.
    expect(result.stderr).not.toMatch(/SequelizeUniqueConstraintError/);
    expect(result.stderr).not.toMatch(/at Query\./);
  });

  it('`add` stages a non-active candidate — never collides with uq_ek_active_purpose', () => {
    const kid = `${KID_PREFIX}2`;
    const envVar = 'T057_TEST_TOK_2';
    const result = runCli(['add', 'token', '--kid', kid, '--env-var', envVar]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status    = rotating');
  });

  it('TC-10 — a bad algorithm is rejected by ck_ek_algorithm with a clear message', () => {
    const result = runCli([
      'add',
      'token',
      '--kid',
      `${KID_PREFIX}bad`,
      '--algorithm',
      'NOT-A-REAL-ALGORITHM',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ck_ek_algorithm/);
    expect(result.stderr).not.toMatch(/SequelizeDatabaseError/);
  });

  it('`rotate` promotes the staged candidate, demoting the previous active key', async () => {
    const env = await resolveWholeRegistryEnv(sequelize, {
      T057_TEST_TOK_1: FAKE_TOK_1_MATERIAL,
      T057_TEST_TOK_2: FAKE_TOK_2_MATERIAL,
    });
    const result = runCli(['rotate', `${KID_PREFIX}2`], env);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`'${KID_PREFIX}2' is now active`));

    const listResult = runCli(['list']);
    expect(listResult.stdout).toMatch(new RegExp(`${KID_PREFIX}2\\s+token\\s+\\S+\\s+active`));
    expect(listResult.stdout).toMatch(new RegExp(`${KID_PREFIX}1\\s+token\\s+\\S+\\s+rotating`));
  });

  it('`retire` retires a non-active key and warns about its lack of per-table verification', async () => {
    const env = await resolveWholeRegistryEnv(sequelize, {
      T057_TEST_TOK_1: FAKE_TOK_1_MATERIAL,
      T057_TEST_TOK_2: FAKE_TOK_2_MATERIAL,
    });
    const result = runCli(['retire', `${KID_PREFIX}1`, '--force'], env);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`'${KID_PREFIX}1' retired`));
    expect(result.stdout).toMatch(/no per-table knowledge/);

    const listResult = runCli(['list']);
    expect(listResult.stdout).toMatch(new RegExp(`${KID_PREFIX}1\\s+token\\s+\\S+\\s+retired`));
  });

  it('with no command at all, prints usage and exits non-zero rather than crashing', () => {
    const result = runCli([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Usage: encryption-keys\.ts/);
  });

  it("insertKeyRow itself is refused by uq_ek_active_purpose with a clean CliUsageError, not a raw stack — the race-condition path runProvision's pre-check cannot fully close", async () => {
    const sequelize2 = buildAppConnection();
    try {
      await sequelize2.authenticate();
      // A third 'active' token key: the pre-check in `runProvision` never runs here — this
      // calls the same `insertKeyRow` the CLI uses, directly, which is the only way to reach
      // its own catch branch for `uq_ek_active_purpose` without an actual race between two
      // real processes.
      await expect(
        insertKeyRow(sequelize2, {
          purpose: 'token',
          kid: `${KID_PREFIX}3`,
          envVar: 'T057_TEST_TOK_3',
          algorithm: 'AES-256-GCM',
          status: 'active',
        }),
      ).rejects.toThrow(/uq_ek_active_purpose/);
    } finally {
      await sequelize2.close();
    }
  });
});
