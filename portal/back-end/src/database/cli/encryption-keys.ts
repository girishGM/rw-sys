#!/usr/bin/env node
/**
 * T-057 (D-2) — the ops CLI wrapper `rotate-keys.command.ts` anticipated and no task ever
 * built: "Which kids exist, and which env vars hold them, is a deployment decision"
 * (T016_001_encryption_keys.ts's own header) is correct, but nothing implemented that
 * decision. Without this file, a correct clone of the repo cannot create its first
 * `encryption_keys` row, `bootstrap:superadmin` has no key to encrypt `portal_users.email`
 * with, and the portal cannot create its first user — "not yet deployed" was actually "not
 * deployable".
 *
 * Usage (run from `back-end/`, same convention as `migrate.ts`/`bootstrap-superadmin.ts`):
 *
 *   npx ts-node -T -r tsconfig-paths/register src/database/cli/encryption-keys.ts <command> [args]
 *
 * Commands:
 *
 *   provision <purpose> [--kid KID] [--env-var NAME] [--algorithm ALG]
 *       Inserts the FIRST **active** key for a purpose ('field' | 'blind_index' |
 *       'transport' | 'token'). Generates 32 random bytes, prints the base64 value and the
 *       env var name to place it under **once**, then inserts the encryption_keys row.
 *       Refuses — with a plain message, never a raw constraint-violation stack — if an
 *       active key already exists for that purpose (uq_ek_active_purpose): that is what
 *       `add` + `rotate` are for.
 *
 *   add <purpose> [--kid KID] [--env-var NAME] [--algorithm ALG]
 *       Same as `provision`, but always inserts as `rotating` (never `active`) — the primitive
 *       `rotate-keys.command.ts`'s own `activateKey()` needs but has no way to create on its
 *       own: a *candidate* key row, staged ahead of promoting it. Never collides with
 *       `uq_ek_active_purpose`, because it never writes `status='active'`.
 *
 *   list
 *       Every encryption_keys row (kid, purpose, algorithm, status, key_ref, timestamps).
 *       Never key material — none of it is ever stored in the database in the first place.
 *
 *   rotate <kid>
 *       Promotes `kid` to `active`, demoting the previous active key of the same purpose to
 *       `rotating` — a thin wrapper around `RotateKeysCommand.activateKey()` (T-016's own
 *       engine; this file adds no crypto logic of its own). The key material for every
 *       existing row must already be reachable in the process environment (or `.env`, via
 *       T-057 D-3's fix) before this runs — the engine reloads the whole registry as its
 *       last step and fails loudly if anything is missing.
 *
 *   retire <kid> [--force]
 *       Retires `kid` — a thin wrapper around `RotateKeysCommand.retireKey()`. Called with no
 *       `targets`, because this CLI has no per-table knowledge of what to check (that list
 *       lives with each consuming task, e.g. T-056's `PortalUserEmailCrypto` target) — so the
 *       engine's own "refuse while rows still use this key" protection does not run here.
 *       `--force` is accepted for symmetry with the engine's own option but changes nothing
 *       in that case; it matters once a caller supplies targets, which this CLI does not.
 *       A prominent warning is printed either way.
 *
 * Connects as the **app** role (`DB_APP_*`), the same reasoning
 * `back-end/src/cli/bootstrap-superadmin.ts` gives for itself: inserting or updating an
 * `encryption_keys` row is ordinary application data, not schema DDL — `T002_008_grants.ts`
 * already grants `reward_app` everything it needs on `reward_portal`.
 */
/* eslint-disable no-console -- T-057: this is a CLI script; printing status IS its job. */
import 'reflect-metadata';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';
import { Sequelize } from 'sequelize-typescript';
import { DatabaseError, QueryTypes, UniqueConstraintError } from 'sequelize';
import { validateEnv } from '@/config/env.schema';
import {
  BlindIndexService,
  EnvKeyMaterialResolver,
  FieldCryptoService,
  KEY_PURPOSES,
  KID_PATTERN,
  KeyRegistryService,
  RotateKeysCommand,
  UnconfiguredKmsResolver,
  type KeyAlgorithm,
  type KeyPurpose,
} from '@/common/crypto';

/** Thrown for every refusal this CLI produces on purpose — mapped to a clean one-line
 * message and exit code 1, never a raw stack trace (D-2's own TC-8). */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

function fail(message: string): never {
  throw new CliUsageError(message);
}

// --- naming defaults --------------------------------------------------------------------

/** `YYYYMMDD`, UTC — stable within a single day, human-readable in `list` output. */
export function todayStamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
}

export function defaultKid(purpose: KeyPurpose): string {
  return `${purpose}_${todayStamp()}`;
}

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Uppercases and sanitises a candidate into something `ENV_NAME_PATTERN` accepts — `kid`
 * permits `-`, an env var name cannot. */
export function sanitiseEnvVarName(value: string): string {
  const upper = value.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return ENV_NAME_PATTERN.test(upper) ? upper : `K_${upper}`;
}

export function defaultEnvVar(kid: string): string {
  return sanitiseEnvVarName(kid);
}

/** Mirrors `KeyRegistryService`'s own purpose→algorithm pairing exactly
 * (`key-registry.service.ts`, `loadOne()`): every purpose is AES-256-GCM except
 * `blind_index`, which is HMAC-SHA256. Duplicated rather than imported because the registry
 * does not export it — it is derived here only to pick a sensible default, never to bypass
 * the registry's own check, which still runs (at `rotate`/`retire`/boot time) regardless of
 * what this CLI decided. */
export function expectedAlgorithm(purpose: KeyPurpose): KeyAlgorithm {
  return purpose === 'blind_index' ? 'HMAC-SHA256' : 'AES-256-GCM';
}

// --- argv parsing ------------------------------------------------------------------------

export function parseFlags(args: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) {
      fail(`Unexpected argument '${token}'.`);
    }
    const name = token.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`Flag --${name} requires a value.`);
    }
    out[name] = value;
    i += 1;
  }
  return out;
}

export interface KeyRowArgs {
  purpose: KeyPurpose;
  kid: string;
  envVar: string;
  algorithm: KeyAlgorithm;
}

export function parseKeyRowArgs(argv: readonly string[]): KeyRowArgs {
  const [purposeArg, ...rest] = argv;
  if (!purposeArg || !KEY_PURPOSES.includes(purposeArg as KeyPurpose)) {
    fail(`A purpose is required — one of: ${KEY_PURPOSES.join(', ')}.`);
  }
  const purpose = purposeArg as KeyPurpose;
  const flags = parseFlags(rest);

  const kid = flags.kid ?? defaultKid(purpose);
  if (!KID_PATTERN.test(kid)) {
    fail(`--kid '${kid}' is not a valid kid (expected ${String(KID_PATTERN)}).`);
  }

  const envVar = flags['env-var'] ?? defaultEnvVar(kid);
  if (!ENV_NAME_PATTERN.test(envVar)) {
    fail(`--env-var '${envVar}' is not a valid environment-variable name.`);
  }

  const algorithm = (flags.algorithm as KeyAlgorithm | undefined) ?? expectedAlgorithm(purpose);

  return { purpose, kid, envVar, algorithm };
}

// --- DB access -----------------------------------------------------------------------------

/** Constraint name pg reports, when available, so the friendly message can name the actual
 * cause rather than guessing from the error class alone. */
export function pgConstraint(err: unknown): string | undefined {
  const original = (err as { original?: { constraint?: string } } | undefined)?.original;
  return original?.constraint;
}

export async function insertKeyRow(
  sequelize: Sequelize,
  args: KeyRowArgs & { status: 'active' | 'rotating' },
): Promise<void> {
  try {
    await sequelize.query(
      `INSERT INTO reward_portal.encryption_keys (kid, purpose, algorithm, key_ref, status)
       VALUES (:kid, :purpose, :algorithm, :keyRef, :status)`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          kid: args.kid,
          purpose: args.purpose,
          algorithm: args.algorithm,
          keyRef: `env:${args.envVar}`,
          status: args.status,
        },
      },
    );
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const constraint = pgConstraint(err);
      if (constraint === 'uq_ek_active_purpose') {
        fail(
          `Refused: an active '${args.purpose}' key already exists — exactly one active key ` +
            `per purpose is allowed (uq_ek_active_purpose). Use 'add ${args.purpose}' to stage ` +
            `a candidate key, then 'rotate <kid>' to promote it.`,
        );
      }
      fail(
        `Refused: kid '${args.kid}' already exists (${constraint ?? 'unique constraint'}). ` +
          `Choose a different --kid.`,
      );
    }
    if (err instanceof DatabaseError) {
      const code = (err.original as { code?: string } | undefined)?.code;
      const constraint = pgConstraint(err);
      if (code === '23514') {
        fail(
          `Refused by database constraint '${constraint ?? 'unknown'}' — the purpose/` +
            `algorithm/status combination supplied is not permitted for encryption_keys.`,
        );
      }
    }
    throw err;
  }
}

export interface EncryptionKeyRow {
  kid: string;
  purpose: string;
  algorithm: string;
  status: string;
  key_ref: string;
  activated_at: string;
  retired_at: string | null;
}

export async function listKeyRows(sequelize: Sequelize): Promise<EncryptionKeyRow[]> {
  return sequelize.query<EncryptionKeyRow>(
    `SELECT kid, purpose, algorithm, status, key_ref, activated_at, retired_at
       FROM reward_portal.encryption_keys
      ORDER BY id`,
    { type: QueryTypes.SELECT },
  );
}

/** Assembles the same crypto stack `bootstrap-superadmin.ts` builds for itself, standalone
 * (no Nest DI container) — needed by `rotate`/`retire`, which delegate to T-016's engine. */
export function buildRotateCommand(sequelize: Sequelize): RotateKeysCommand {
  const registry = new KeyRegistryService(sequelize, [
    new EnvKeyMaterialResolver(),
    new UnconfiguredKmsResolver(),
  ]);
  const fieldCrypto = new FieldCryptoService(registry);
  const blindIndex = new BlindIndexService(registry);
  return new RotateKeysCommand(sequelize, registry, fieldCrypto, blindIndex);
}

// --- output ---------------------------------------------------------------------------------

function printProvisioned(args: KeyRowArgs, status: string, materialBase64: string): void {
  console.log('\n  ✓ encryption_keys row created:');
  console.log(`    kid       = ${args.kid}`);
  console.log(`    purpose   = ${args.purpose}`);
  console.log(`    algorithm = ${args.algorithm}`);
  console.log(`    status    = ${status}`);
  console.log(`    key_ref   = env:${args.envVar}`);
  console.log(
    '\n  ── KEY MATERIAL — shown once, never stored anywhere by this command ───────────',
  );
  console.log(`    ${args.envVar}=${materialBase64}`);
  console.log('  ─────────────────────────────────────────────────────────────────────────');
  console.log(
    `\n  Place this value in your secret manager, or in this environment's own ` +
      `.env.<environment> file (never committed — see .env.example), under the name above.`,
  );
  console.log(
    `  Export it in the real process environment before the API starts. This command will ` +
      `not print it again.\n`,
  );
}

// --- commands ---------------------------------------------------------------------------

export async function runProvision(sequelize: Sequelize, argv: readonly string[]): Promise<void> {
  const args = parseKeyRowArgs(argv);
  const [{ count }] = await sequelize.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM reward_portal.encryption_keys
      WHERE purpose = :purpose AND status = 'active'`,
    { type: QueryTypes.SELECT, replacements: { purpose: args.purpose } },
  );
  if (count > 0) {
    fail(
      `Refused: an active '${args.purpose}' key already exists. Use 'add ${args.purpose}' to ` +
        `stage a candidate key, then 'rotate <kid>' to promote it.`,
    );
  }

  const material = randomBytes(32).toString('base64');
  await insertKeyRow(sequelize, { ...args, status: 'active' });
  printProvisioned(args, 'active', material);
}

export async function runAdd(sequelize: Sequelize, argv: readonly string[]): Promise<void> {
  const args = parseKeyRowArgs(argv);
  const material = randomBytes(32).toString('base64');
  await insertKeyRow(sequelize, { ...args, status: 'rotating' });
  printProvisioned(args, "rotating (staged — run 'rotate <kid>' to activate)", material);
}

export async function runList(sequelize: Sequelize): Promise<void> {
  const rows = await listKeyRows(sequelize);
  if (rows.length === 0) {
    console.log('\n  (no encryption_keys rows)\n');
    return;
  }
  console.log('\n  kid                  purpose      algorithm     status    key_ref');
  console.log('  ' + '-'.repeat(78));
  for (const row of rows) {
    console.log(
      `  ${row.kid.padEnd(20)} ${row.purpose.padEnd(12)} ${row.algorithm.padEnd(13)} ` +
        `${row.status.padEnd(9)} ${row.key_ref}`,
    );
  }
  console.log();
}

export async function runRotate(sequelize: Sequelize, argv: readonly string[]): Promise<void> {
  const kid = argv[0];
  if (!kid) fail('Usage: rotate <kid>');
  await buildRotateCommand(sequelize).activateKey(kid);
  console.log(`\n  ✓ '${kid}' is now active.\n`);
}

export async function runRetire(sequelize: Sequelize, argv: readonly string[]): Promise<void> {
  const kid = argv[0];
  if (!kid) fail('Usage: retire <kid> [--force]');
  const force = argv.includes('--force');
  console.log(
    `\n  ⚠ This CLI has no per-table knowledge of what still holds ciphertext under '${kid}'. ` +
      `Retiring proceeds without that check — run the application's own rotation target list ` +
      `(e.g. T-056's PortalUserEmailCrypto targets) through 'npm run db:migrate'-adjacent ` +
      `tooling first if you are not certain every row has already been rotated off this key.\n`,
  );
  await buildRotateCommand(sequelize).retireKey(kid, [], { force });
  console.log(`  ✓ '${kid}' retired.\n`);
}

// --- CLI-only concerns: env loading, connection, exit codes -------------------------------

/** Same `.env.local` > `.env.<NODE_ENV>` > `.env` precedence as `migrate.ts` and
 * `bootstrap-superadmin.ts`, duplicated for the same reason those two give: this script runs
 * standalone, and both of those files live outside this task's own scope. */
export function loadEnvFiles(): void {
  const backEndDir = path.join(__dirname, '..', '..', '..');
  dotenv.config({ path: path.join(backEndDir, '.env.local'), quiet: true });
  dotenv.config({
    path: path.join(backEndDir, `.env.${process.env.NODE_ENV || 'development'}`),
    quiet: true,
  });
  dotenv.config({ path: path.join(backEndDir, '.env'), quiet: true });
}

export function buildAppConnection(): Sequelize {
  const env = validateEnv(process.env);
  return new Sequelize({
    dialect: 'postgres',
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    username: env.DB_APP_USERNAME,
    password: env.DB_APP_PASSWORD,
    logging: false,
    dialectOptions: env.DB_SSL ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  });
}

function printUsage(): void {
  console.error(
    [
      '',
      '  Usage: encryption-keys.ts <command> [args]',
      '',
      '  Commands:',
      '    provision <purpose> [--kid KID] [--env-var NAME] [--algorithm ALG]',
      '    add       <purpose> [--kid KID] [--env-var NAME] [--algorithm ALG]',
      '    list',
      '    rotate    <kid>',
      '    retire    <kid> [--force]',
      '',
      `  purpose: ${KEY_PURPOSES.join(' | ')}`,
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  loadEnvFiles();

  const [command, ...rest] = process.argv.slice(2);
  if (!command || !['provision', 'add', 'list', 'rotate', 'retire'].includes(command)) {
    printUsage();
    process.exit(1);
  }

  const sequelize = buildAppConnection();
  try {
    await sequelize.authenticate();

    if (command === 'provision') await runProvision(sequelize, rest);
    else if (command === 'add') await runAdd(sequelize, rest);
    else if (command === 'list') await runList(sequelize);
    else if (command === 'rotate') await runRotate(sequelize, rest);
    else if (command === 'retire') await runRetire(sequelize, rest);
  } catch (err) {
    if (err instanceof CliUsageError) {
      console.error(`\n  ✗ ${err.message}\n`);
      process.exit(1);
    }
    console.error('\n  ✗ Command failed:\n');
    console.error(err);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
