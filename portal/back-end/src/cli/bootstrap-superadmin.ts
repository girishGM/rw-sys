#!/usr/bin/env node
/**
 * `npm run bootstrap:superadmin` — T-004 (01-DATABASE.md §5.5, gap G7). The one-shot,
 * human-run command that creates the very first `super_admin`, since nothing else in the
 * portal can create a user before at least one exists to do the creating.
 *
 * Connects as the **app** role (`DB_APP_*`, `reward_app`), never the privileged migration
 * role — inserting a `portal_users`/`portal_user_credentials` row is ordinary application
 * data, not schema DDL, and `T002_008_grants.ts` already grants `reward_app` everything it
 * needs on `reward_portal` (`GRANT ALL ON ALL TABLES IN SCHEMA reward_portal`). Uses raw
 * parameterised SQL rather than the Sequelize models, deliberately: this script runs
 * standalone (`ts-node`, no Nest DI container), and the four safety rules below are the
 * entire job — pulling in the full `PORTAL_MODELS`/`REWARD_CONFIG_MODELS` association graph
 * (`sequelize.provider.ts`) would be a lot of unrelated surface for one INSERT pair.
 *
 * The four safety rules (task file, all required):
 *   1. Refuses to run if any `super_admin` already exists (exit 1, clear message) — checked
 *      *before* anything else, including before prompting for a password, so a second run
 *      never even asks.
 *   2. Reads the password from `SUPERADMIN_PASSWORD` or an interactive hidden prompt. No
 *      literal password value anywhere in this file, ever (grepped for and confirmed empty —
 *      see the completion report's TC-13).
 *   3. Enforces the password policy: >= 12 chars, at least three of
 *      {lower, upper, digit, symbol}, not the email local-part, not a common password.
 *      This mirrors T-010's own `PasswordPolicyService` spec (`T-010-credentials-core.md`
 *      implementation note 3) for consistency, even though T-010 hasn't landed yet — this
 *      script does not depend on it and has its own self-contained check.
 *   4. Sets `must_change_password = true` and `status = 'active'`.
 *
 * `SUPERADMIN_EMAIL` / `SUPERADMIN_NAME` are not named in the task file's four rules but are
 * obviously required to create *any* user row — same env-or-prompt pattern as the password,
 * with plain (non-hidden) prompts since neither is a secret.
 */
/* eslint-disable no-console -- T-004: this is a CLI script; printing status IS its job. */
import 'reflect-metadata';
import path from 'node:path';
import readline from 'node:readline';
import dotenv from 'dotenv';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import * as argon2 from 'argon2';
import { validateEnv } from '@/config/env.schema';
import {
  BlindIndexService,
  EnvKeyMaterialResolver,
  FieldCryptoService,
  KeyRegistryService,
  UnconfiguredKmsResolver,
} from '@/common/crypto';
import { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import { dataProtectionConfigFactory } from '@/common/data-protection/data-protection.config';

/** OWASP baseline (00-ARCHITECTURE.md §8, "Password hash" row) — the same parameters
 * T-010's own `CredentialService` is specified to use, so a hash created here needs no
 * special-casing by that service once it lands. */
const ARGON2_OPTIONS: argon2.Options & { type: 2 } = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * A small, non-exhaustive guard against the most trivially common passwords — enough to
 * catch a lazy first choice on a fresh install. Not a substitute for T-010's own bundled
 * list (`auth.constants.ts`, out of this task's file scope); this script has its own because
 * it must work standalone, before that module exists.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  [
    'password123',
    'password1234',
    'password1!',
    'Password123',
    'Password123!',
    'passw0rd123',
    'Passw0rd123!',
    'letmein123456',
    'welcome123456',
    'admin123456789',
    'qwertyuiop12',
    'qwertyuiopas',
    '123456789012',
    '1234567890123',
    'iloveyou1234',
    'sunshine1234',
    'princess1234',
    'dragon123456',
    'monkey1234567',
    'football12345',
    'superadmin123',
    'changeme12345',
    'trustno112345',
    'letmein12345!',
  ].map((p) => p.toLowerCase()),
);

export interface PasswordPolicyResult {
  valid: boolean;
  reason?: string;
}

/** Mirrors T-010-credentials-core.md implementation note 3 (see this file's own doc
 * comment). Exported for direct testing without needing a live DB connection. */
export function validatePassword(password: string, emailLocalPart: string): PasswordPolicyResult {
  if (password.length < 12) {
    return { valid: false, reason: 'must be at least 12 characters long' };
  }

  const classCount = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  if (classCount < 3) {
    return {
      valid: false,
      reason: 'must include at least three of: lowercase, uppercase, digit, symbol',
    };
  }

  if (emailLocalPart && password.toLowerCase().includes(emailLocalPart.toLowerCase())) {
    return { valid: false, reason: 'must not contain the email local-part' };
  }

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { valid: false, reason: 'is a commonly used password' };
  }

  return { valid: true };
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/** Thrown when a `super_admin` already exists — rule 1. Distinct type so the CLI entry
 * point can map it to exit code 1 with a specific, predictable message (TC-11). */
export class SuperAdminExistsError extends Error {
  constructor() {
    super('A super_admin already exists.');
    this.name = 'SuperAdminExistsError';
  }
}

/** Thrown when the supplied password fails `validatePassword` — rule 3 (TC-12). */
export class PasswordPolicyError extends Error {
  constructor(reason: string) {
    super(`Password rejected: ${reason}`);
    this.name = 'PasswordPolicyError';
  }
}

/**
 * Assembles the crypto stack this script needs, without a Nest container — T-056.
 *
 * `portal_users.email` is encrypted at rest, so even this standalone script has to encrypt before
 * it can insert. The registry is loaded from `encryption_keys` exactly as the application loads it,
 * and both key purposes are resolved eagerly: a missing `field` or `blind_index` key must stop the
 * command with the registry's own message *before* the transaction opens, not produce a super admin
 * whose address is unreadable or whose blind index is absent (which would create an account that
 * cannot log in — the failure this task exists to prevent).
 */
async function buildEmailCrypto(sequelize: Sequelize): Promise<PortalUserEmailCrypto> {
  const registry = new KeyRegistryService(sequelize, [
    new EnvKeyMaterialResolver(),
    new UnconfiguredKmsResolver(),
  ]);
  await registry.load();
  registry.getActiveKey('field');
  registry.getActiveKey('blind_index');

  return new PortalUserEmailCrypto(
    new FieldCryptoService(registry),
    new BlindIndexService(registry),
    dataProtectionConfigFactory().atRest.bindRecordIdAsAAD,
  );
}

export interface BootstrapSuperAdminInput {
  email: string;
  displayName: string;
  password: string;
}

export interface BootstrapSuperAdminResult {
  userId: number;
}

/**
 * The whole job, minus process/CLI concerns (env loading, prompting, exit codes) — kept
 * separate from `main()` so it is directly testable against a real database connection
 * without needing a TTY or a child process (see `test/database/t004-seeds-bootstrap.e2e-spec.ts`).
 *
 * Existence check + insert are **not** wrapped in one transaction with the same connection
 * lock the whole time — this is a one-shot, human-run bootstrap tool, not a concurrent API
 * endpoint; the tiny TOCTOU window between the check and the insert is an accepted,
 * documented tradeoff, not an oversight. The insert itself (rule 1 + rules 2-4) runs inside
 * a single transaction so a `portal_users` row is never left without its
 * `portal_user_credentials` row.
 */
export async function bootstrapSuperAdmin(
  sequelize: Sequelize,
  input: BootstrapSuperAdminInput,
): Promise<BootstrapSuperAdminResult> {
  const [{ count }] = await sequelize.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM reward_portal.portal_users
      WHERE role = 'super_admin' AND deleted_at IS NULL`,
    { type: QueryTypes.SELECT },
  );
  if (count > 0) {
    throw new SuperAdminExistsError();
  }

  const emailLocalPart = input.email.split('@')[0] ?? '';
  const policy = validatePassword(input.password, emailLocalPart);
  if (!policy.valid) {
    throw new PasswordPolicyError(policy.reason ?? 'does not meet the password policy');
  }

  const passwordHash = await hashPassword(input.password);

  // T-056. Built before the transaction opens so that a missing or unusable encryption key fails
  // the command before it has written anything, rather than half-way through creating the account.
  const emailCrypto = await buildEmailCrypto(sequelize);

  const t = await sequelize.transaction();
  try {
    // Two-phase, exactly as `model-encryption.hooks.ts` does it and for exactly the same reason:
    // `portal_users.id` is `int generated always as identity`, so the primary key that gets bound
    // into the ciphertext as AAD (07-DATA-PROTECTION.md §4) does not exist until this INSERT has
    // run. Phase 1 writes ciphertext bound to the `#new` placeholder — *never* plaintext, which is
    // the whole point — and phase 2 re-binds it to the real id inside the same transaction.
    const [{ id: userId }] = await sequelize.query<{ id: number }>(
      `INSERT INTO reward_portal.portal_users
           (email, email_bidx, display_name, role, status, must_change_password,
            created_at, updated_at)
       VALUES (:email, :emailBidx, :displayName, 'super_admin', 'active', true, now(), now())
       RETURNING id`,
      {
        type: QueryTypes.SELECT,
        transaction: t,
        replacements: {
          email: emailCrypto.encryptForNewRow(input.email),
          // The blind index is computed from the plaintext and is what the login lookup matches
          // on. Without it this account would exist and be completely unable to sign in.
          emailBidx: emailCrypto.blindIndexFor(input.email),
          displayName: input.displayName,
        },
      },
    );

    // Phase 2. Re-encrypted straight from the plaintext, which this function still holds, rather
    // than decrypting the provisional envelope and re-encrypting it — same result, one less
    // crypto round trip, and no branch that could leave the placeholder AAD in place on failure.
    // Run unconditionally: when `bindRecordIdAsAAD` is off both AADs are already identical, so
    // this simply rewrites the value with a fresh IV instead of needing a special case.
    await sequelize.query(
      `UPDATE reward_portal.portal_users SET email = :email WHERE id = :userId`,
      {
        type: QueryTypes.UPDATE,
        transaction: t,
        replacements: { email: emailCrypto.encryptForRow(userId, input.email), userId },
      },
    );

    await sequelize.query(
      `INSERT INTO reward_portal.portal_user_credentials
           (user_id, password_hash, password_algo, password_updated_at, failed_attempts,
            created_at, updated_at)
       VALUES (:userId, :passwordHash, 'argon2id', now(), 0, now(), now())`,
      {
        type: QueryTypes.INSERT,
        transaction: t,
        replacements: { userId, passwordHash },
      },
    );

    await t.commit();
    return { userId };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

// --- CLI-only concerns below: env loading, prompting, process exit codes -----------------

/** Same `.env.local` > `.env.<NODE_ENV>` > `.env` precedence as
 * `src/database/cli/migrate.ts` — duplicated rather than shared, because this script runs
 * standalone from a different directory and pulling in that file would reach outside this
 * task's own file scope for no real benefit. */
function loadEnvFiles(): void {
  const backEndDir = path.join(__dirname, '..', '..');
  dotenv.config({ path: path.join(backEndDir, '.env.local'), quiet: true });
  dotenv.config({
    path: path.join(backEndDir, `.env.${process.env.NODE_ENV || 'development'}`),
    quiet: true,
  });
  dotenv.config({ path: path.join(backEndDir, '.env'), quiet: true });
}

function promptPlain(query: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Masks keystrokes as `*` while reading a hidden value from a real TTY. Best-effort only —
 * there is no automated test for the masking behaviour itself (it requires a real TTY);
 * every automated test instead supplies `SUPERADMIN_PASSWORD` directly, the same non-TTY
 * path this function is never invoked on. */
function promptHidden(query: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    }) as readline.Interface & { _writeToOutput?: (s: string) => void };

    // readline's internal output stream is not part of its public typings; this is the
    // standard workaround for a masked prompt without adding a new dependency.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above, T-004
    const output = (rl as any).output as NodeJS.WritableStream;
    rl._writeToOutput = (chunk: string) => {
      output.write(chunk === query ? chunk : '*'.repeat(chunk.length));
    };

    rl.question(query, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function resolveInput(): Promise<BootstrapSuperAdminInput> {
  const isTTY = Boolean(process.stdin.isTTY);

  let email = process.env.SUPERADMIN_EMAIL;
  if (!email) {
    if (!isTTY) {
      console.error('SUPERADMIN_EMAIL is required (no interactive terminal available).');
      process.exit(1);
    }
    email = await promptPlain('Super Admin email: ');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('SUPERADMIN_EMAIL is not a valid email address.');
    process.exit(1);
  }

  let displayName = process.env.SUPERADMIN_NAME;
  if (!displayName) {
    if (!isTTY) {
      console.error('SUPERADMIN_NAME is required (no interactive terminal available).');
      process.exit(1);
    }
    displayName = await promptPlain('Super Admin display name: ');
  }
  if (!displayName) {
    console.error('SUPERADMIN_NAME must not be empty.');
    process.exit(1);
  }

  let password = process.env.SUPERADMIN_PASSWORD;
  if (!password) {
    if (!isTTY) {
      console.error('SUPERADMIN_PASSWORD is required (no interactive terminal available).');
      process.exit(1);
    }
    password = await promptHidden('Super Admin password: ');
  }

  return { email, displayName, password };
}

function buildAppConnection(): Sequelize {
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

async function main(): Promise<void> {
  loadEnvFiles();

  const sequelize = buildAppConnection();
  try {
    await sequelize.authenticate();

    // Rule 1 — check *before* asking for anything else, so a re-run never even prompts.
    const [{ count }] = await sequelize.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM reward_portal.portal_users
        WHERE role = 'super_admin' AND deleted_at IS NULL`,
      { type: QueryTypes.SELECT },
    );
    if (count > 0) {
      console.error('\n  ✗ A super_admin already exists.\n');
      process.exit(1);
    }

    const input = await resolveInput();
    const result = await bootstrapSuperAdmin(sequelize, input);
    console.log(`\n  ✓ Super Admin created (id=${result.userId}, email=${input.email}).`);
    console.log(
      '    must_change_password=true — this account must change its password at first login.\n',
    );
  } catch (err) {
    if (err instanceof SuperAdminExistsError) {
      console.error(`\n  ✗ ${err.message}\n`);
      process.exit(1);
    }
    if (err instanceof PasswordPolicyError) {
      console.error(`\n  ✗ ${err.message}\n`);
      process.exit(1);
    }
    console.error('\n  ✗ Bootstrap failed:\n');
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
