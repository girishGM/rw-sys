#!/usr/bin/env node
'use strict';

/**
 * Syncs the local dev database's schema + demo data onto Render's shared reward-portal-db.
 * See reward-system/CLAUDE.md and .claude/commands/sync-db-to-render.md.
 *
 * Usage (from the repo root, Node 20 on PATH):
 *   node scripts/render-db-sync.js              # migrate schema, then apply pending patches
 *   node scripts/render-db-sync.js --status      # report only, no writes
 *   node scripts/render-db-sync.js --skip-migrate  # patches only (schema already current)
 *
 * Two distinct steps, always in this order:
 *
 * 1. SCHEMA — runs `npm run db:migrate` for portal/back-end and promo-code-service against
 *    Render, exactly as portal/docs/RENDER-DB-MIGRATION.md's manual runbook does, via a
 *    throwaway .env this script writes and deletes itself. Always safe to run: Umzug only
 *    applies migrations not already recorded in that database's own `migrations` table, so a
 *    fully-current Render database is a no-op here.
 *
 *    A migration can require an extra env var beyond the plain DB_ and JWT_ ones (T165_001 needs
 *    PROMO_CODE_SERVICE_BASE_URL, discovered the hard way running this by hand the first time)
 *    — EXTRA_MIGRATION_ENV below is the accumulated list. If a future migration fails with
 *    "<X> is required", add it there; this script has no way to discover that need in advance.
 *
 * 2. DEMO DATA — reward_config/promo_code hold both real demo content and ad hoc
 *    E2E/scratch/test rows in the very same tables (names like T166E2E, scratch-, repro), and
 *    local ids never carry over to Render as-is (identity columns diverged independently per
 *    environment — verified 2026-09-03 building this script, see the header comment on
 *    scripts/db-sync/patches/001_welcome_streak_live_demo.sql for the full story). There is no
 *    safe *automatic* "diff and copy" for that reason. Instead:
 *      - scripts/db-sync/patches/*.sql holds hand-written, reviewed SQL for one specific
 *        addition each (a demo campaign + its tracker/rule/promo-code graph, resolved against
 *        Render's own existing rows by natural key — name/code, never a raw local id).
 *      - reward_portal.demo_data_patches (created here if missing) tracks which patch
 *        filenames have already run against THIS database — the same pattern Umzug already
 *        uses for schema migrations, just for hand-authored data patches instead of generated
 *        DDL. A patch is applied at most once per database, in filename order, each in its own
 *        transaction (BEGIN...COMMIT already inside the file) — a failure stops the run and
 *        leaves every later patch un-applied, un-recorded.
 *      - Writing a NEW patch: figure out the target Render tenant/merchant/rule/activity ids by
 *        querying Render directly and matching by name/code (never assume a local id — or even
 *        a local tenant number — means the same thing on Render). Keep it purely additive
 *        unless a human has explicitly decided otherwise (see AskUserQuestion precedent in this
 *        script's own commit — replacing/deleting existing Render demo rows is a judgment call,
 *        not something this tool should ever default to).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { getApiKey, getPostgresConnectionInfo } = require('./render-api');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY = require(path.join(ROOT, 'scripts', 'render-registry.json'));
const PATCHES_DIR = path.join(__dirname, 'db-sync', 'patches');

const NODE20_BIN = path.join(os.homedir(), '.nvm/versions/node/v20.20.2/bin');
function withNode20(env) {
  if (!fs.existsSync(NODE20_BIN)) return env;
  return { ...env, PATH: `${NODE20_BIN}:${env.PATH}` };
}

const PSQL = '/Library/PostgreSQL/16/bin/psql';
const psqlBin = fs.existsSync(PSQL) ? PSQL : 'psql';

function readDotEnvValue(filePath, key) {
  if (!fs.existsSync(filePath)) return null;
  const line = fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${key}=`) || l.startsWith(`#${key}=`));
  if (!line) return null;
  return line.replace(/^#?/, '').slice(key.length + 1);
}

// Migrations discovered so far that validate more than the plain DB_/JWT_ env vars — see header.
const EXTRA_MIGRATION_ENV = {
  portal: {
    PROMO_CODE_SERVICE_BASE_URL: 'https://promo-code-service.onrender.com',
  },
  'promo-code-service': {
    KAFKA_BROKERS: 'localhost:9092', // schema-required but never read by the migration CLI itself
  },
};

function runMigrations(project, cwd, conn) {
  const envPath = path.join(cwd, '.env');
  const backupPath = path.join(cwd, '.env.render-db-sync-backup');
  const hadExisting = fs.existsSync(envPath);
  if (hadExisting) fs.renameSync(envPath, backupPath);

  const jwtPrivate = readDotEnvValue(path.join(cwd, '.env.render'), 'JWT_PRIVATE_KEY') || '';
  const jwtPublic = readDotEnvValue(path.join(cwd, '.env.render'), 'JWT_PUBLIC_KEY') || '';
  const extra = EXTRA_MIGRATION_ENV[project] || {};

  const lines = [
    'NODE_ENV=production',
    `DB_HOST=${conn.host}`,
    `DB_PORT=${conn.port}`,
    `DB_NAME=${conn.database}`,
    'DB_SSL=true',
    `DB_MIGRATION_USERNAME=${conn.migrationUser}`,
    `DB_MIGRATION_PASSWORD=${conn.migrationPassword}`,
    `DB_APP_USERNAME=${project === 'promo-code-service' ? 'promo_code_app' : 'reward_app'}`,
    'DB_APP_PASSWORD=migration-run-placeholder-not-real', // never used to connect, see header
    ...(jwtPrivate ? [`JWT_PRIVATE_KEY=${jwtPrivate}`] : []),
    ...(jwtPublic ? [`JWT_PUBLIC_KEY=${jwtPublic}`] : []),
    ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
  ];
  fs.writeFileSync(envPath, lines.join('\n') + '\n');

  try {
    console.log(`\n--- ${project}: db:migrate against Render ---`);
    execFileSync('npm', ['run', 'db:migrate'], {
      cwd,
      env: withNode20({ ...process.env, NODE_ENV: 'production' }),
      stdio: 'inherit',
    });
  } finally {
    fs.unlinkSync(envPath);
    if (hadExisting) fs.renameSync(backupPath, envPath);
  }
}

function psql(conn, args) {
  return execFileSync(psqlBin, [conn.externalConnectionString, ...args], {
    encoding: 'utf8',
  });
}

function ensureTrackingTable(conn) {
  psql(conn, [
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `CREATE TABLE IF NOT EXISTS reward_portal.demo_data_patches (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     );`,
  ]);
}

function appliedPatches(conn) {
  const out = psql(conn, ['-t', '-A', '-c', 'SELECT name FROM reward_portal.demo_data_patches;']);
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
}

function applyPatch(conn, file) {
  console.log(`  applying ${file} ...`);
  psql(conn, ['-v', 'ON_ERROR_STOP=1', '-f', path.join(PATCHES_DIR, file)]);
  psql(conn, [
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `INSERT INTO reward_portal.demo_data_patches (name) VALUES ('${file.replace(/'/g, "''")}');`,
  ]);
  console.log(`  ✓ ${file}`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const apiKey = getApiKey();
  const raw = await getPostgresConnectionInfo(apiKey, REGISTRY.postgres.id);
  const url = new URL(raw.externalConnectionString);
  const conn = {
    externalConnectionString: raw.externalConnectionString,
    host: url.hostname,
    port: url.port || '5432',
    database: url.pathname.replace(/^\//, ''),
    migrationUser: decodeURIComponent(url.username),
    migrationPassword: raw.password,
  };

  ensureTrackingTable(conn);

  if (args.has('--status')) {
    console.log('Applied demo-data patches:');
    for (const name of appliedPatches(conn)) console.log(`  ✓ ${name}`);
    const all = fs.existsSync(PATCHES_DIR) ? fs.readdirSync(PATCHES_DIR).filter((f) => f.endsWith('.sql')) : [];
    const applied = appliedPatches(conn);
    const pending = all.filter((f) => !applied.has(f));
    console.log('Pending demo-data patches:');
    for (const name of pending) console.log(`  · ${name}`);
    return;
  }

  if (!args.has('--skip-migrate')) {
    runMigrations('portal', path.join(ROOT, 'portal', 'back-end'), conn);
    runMigrations('promo-code-service', path.join(ROOT, 'promo-code-service'), conn);
  }

  const all = fs.existsSync(PATCHES_DIR)
    ? fs.readdirSync(PATCHES_DIR).filter((f) => f.endsWith('.sql')).sort()
    : [];
  const applied = appliedPatches(conn);
  const pending = all.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log('\nNo pending demo-data patches.');
    return;
  }

  console.log(`\n--- applying ${pending.length} demo-data patch(es) ---`);
  for (const file of pending) {
    applyPatch(conn, file);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
