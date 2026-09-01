import { Sequelize } from 'sequelize-typescript';
import { validateConfig } from '../config/config.schema';

/**
 * The PRIVILEGED database connection, used only by the migration CLI
 * (`src/database/cli/migrate.ts`) — never imported into application runtime code.
 *
 * Migrations need to `CREATE SCHEMA`, `CREATE EXTENSION`, `CREATE ROLE`/`GRANT` (01-DATABASE.md
 * §§1-5, T-PC-002 note 6) — none of which the app's own least-privilege `promo_code_app` role
 * can do, by design (R1, AGENT-PROTOCOL.md). Using this connection anywhere outside the
 * migration CLI defeats the entire point of having a narrower runtime role; if you're tempted
 * to import this from a service or controller, that operation belongs in a migration, not in
 * request-time code.
 *
 * Reuses `validateConfig` (src/config/config.schema.ts) rather than reading `process.env`
 * directly, so a missing `DB_MIGRATION_USERNAME`/`DB_MIGRATION_PASSWORD` fails loudly with the
 * same clear message the app's own boot path uses (R4 — no default secret in a committed file).
 */
export function createMigrationConnection(): Sequelize {
  const env = validateConfig(process.env);

  return new Sequelize({
    dialect: 'postgres',
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    username: env.DB_MIGRATION_USERNAME,
    password: env.DB_MIGRATION_PASSWORD,
    logging: false,
    dialectOptions: env.DB_SSL ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  });
}
