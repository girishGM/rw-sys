import { Sequelize } from 'sequelize-typescript';

/**
 * The PRIVILEGED database connection, used only by the migration CLI
 * (`src/database/cli/migrate.ts`) — never imported into application runtime code.
 *
 * Migrations need to `CREATE SCHEMA`/`CREATE EXTENSION` now, and will need `CREATE ROLE`/`GRANT`
 * once T-RR-003's `rr_app` role migration lands — none of which this service's own
 * least-privilege `rr_app` runtime role can do, by design (R1, AGENT-PROTOCOL.md). Using this
 * connection anywhere outside the migration CLI defeats the entire point of having a narrower
 * runtime role; if you're tempted to import this from a service or controller, that operation
 * belongs in a migration, not in request-time code.
 *
 * Unlike RAP's/promo-code-service's own `migration-connection.ts` (both of which reuse a
 * `validateConfig` from `src/config/config.schema.ts`), this file reads `DB_*` directly from
 * `process.env` with its own minimal, fail-loud check: this plan's own T-RR-001 deliberately did
 * NOT create `src/config/config.schema.ts` in the scaffold task (unlike both siblings — see that
 * task's own file, "T-RR-004 will be the authoritative, validated schema"), and T-RR-004 (Config
 * module) is not a dependency of this task or of T-RR-003. Reaching into `src/config/**` from here
 * would mean shipping half of another task's owned file ahead of it. Once T-RR-004 lands, a later
 * task may choose to switch this over to `validateConfig` for consistency with the siblings — not
 * this task's call to make unilaterally.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name} — set it in .env.development (see ` +
        '.env.example) before running the migration CLI.',
    );
  }
  return value;
}

export function createMigrationConnection(): Sequelize {
  const host = requireEnv('DB_HOST');
  const port = Number(requireEnv('DB_PORT'));
  const database = requireEnv('DB_NAME');
  const username = requireEnv('DB_MIGRATION_USERNAME');
  const password = requireEnv('DB_MIGRATION_PASSWORD');
  const ssl = (process.env.DB_SSL ?? 'false').toLowerCase() === 'true';

  if (!Number.isFinite(port)) {
    throw new Error(`DB_PORT must be a number, got "${process.env.DB_PORT}"`);
  }

  return new Sequelize({
    dialect: 'postgres',
    host,
    port,
    database,
    username,
    password,
    logging: false,
    dialectOptions: ssl ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  });
}
