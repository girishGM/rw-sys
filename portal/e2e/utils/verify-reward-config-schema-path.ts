/**
 * T-155 regression check — proves `readRewardConfigSchemaSql()` (this directory's own `db.ts`)
 * resolves to a real, readable file that actually looks like the `reward_config` schema DDL.
 *
 * Why this exists as its own script, separate from `global-setup.ts` calling the same function:
 * `global-setup.ts` calls `loadRewardConfigSchema` (which calls this) as step 2 of booting the
 * *entire* stack — Testcontainers Postgres, migrations, the real back end and front end, a real
 * headless-browser MFA enrolment — so an ENOENT here has always failed the whole suite, just at
 * the cost of paying for every step before it first. T-155 found exactly that: the
 * 2026-08-29 `database/` restructuring moved this file from `database/reward_config_postgres.sql`
 * to `database/reward_config/reward_config_postgres.sql`, and three places (this file's own
 * `db.ts`, `docker-compose.yml`, `docs/DEPLOYMENT.md`) still pointed at the old, flat path. This
 * script isolates that one failure mode — a pure filesystem check, no Docker/Postgres/browser
 * dependency — so it can be caught in well under a second instead of only after the full
 * Testcontainers + browser boot in `global-setup.ts` gets there and fails.
 *
 * Run directly: `npm run check:reward-config-path` (from `portal/e2e/`), or
 * `node -r ts-node/register/transpile-only utils/verify-reward-config-schema-path.ts`.
 * Exits 0 and prints a one-line OK on success; exits 1 with a diagnostic otherwise — the same
 * convention this directory's `perf/*.ts` scripts use.
 */
import { readRewardConfigSchemaSql } from './db';

function main(): void {
  let sql: string;
  try {
    sql = readRewardConfigSchemaSql();
  } catch (err) {
    console.error('FAIL: readRewardConfigSchemaSql() could not read the reward_config schema file.');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  // Sanity-check the content, not just that *a* file was found — an empty or unrelated file at
  // the resolved path would otherwise pass silently.
  if (!/create\s+table/i.test(sql) || !sql.includes('reward_config.countries')) {
    console.error(
      'FAIL: a file was read, but it does not look like reward_config_postgres.sql ' +
        '(no CREATE TABLE / reward_config.countries found). Wrong file at the resolved path?',
    );
    process.exit(1);
    return;
  }

  console.log(
    `OK: readRewardConfigSchemaSql() resolved a real reward_config schema file (${sql.length} bytes).`,
  );
}

main();
