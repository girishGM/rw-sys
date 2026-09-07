import { Sequelize } from 'sequelize-typescript';
import { validateConfig } from '../config/config.schema';

/**
 * The PRIVILEGED database connection, used only by the migration CLI
 * (`src/database/cli/migrate.ts`) — never imported into application runtime code.
 *
 * Migrations need to `CREATE SCHEMA`, `CREATE EXTENSION`, `CREATE ROLE`/`GRANT`
 * (`brain-storm/02-DATA-MODEL.md`, `AGENT-PROTOCOL.md` R2) — none of which this service's own
 * least-privilege `reward_tracking_app` role can do, by design. Using this connection anywhere
 * outside the migration CLI defeats the entire point of having a narrower runtime role; if you're
 * tempted to import this from a service or controller, that operation belongs in a migration, not
 * in request-time code.
 *
 * Reuses `validateConfig` (`src/config/config.schema.ts`, already built by T-RTS-001 with
 * `DB_MIGRATION_USERNAME`/`DB_MIGRATION_PASSWORD` in its schema) rather than reading
 * `process.env` directly, so a missing value fails loudly with the same clear message the app's
 * own boot path uses (R12 — no default secret in a committed file). Mirrors
 * `realtime-activity-processing-service/src/database/migration-connection.ts` verbatim in shape.
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
