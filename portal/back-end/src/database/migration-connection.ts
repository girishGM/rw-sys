import { Sequelize } from 'sequelize-typescript';
import { validateEnv } from '@/config/env.schema';

/**
 * The PRIVILEGED database connection, used only by the migration runner
 * (src/database/cli/migrate.ts) — never imported into application runtime code.
 *
 * Migrations need to `CREATE SCHEMA`, `GRANT`, and run the two authorised `reward_config`
 * `ALTER TABLE ... DROP NOT NULL` statements (01-DATABASE.md §3, §4) — none of which the
 * app's own least-privilege `reward_app` role can do, by design (T-002 note 6). Using this
 * connection anywhere outside the migration CLI defeats the entire point of having a
 * narrower runtime role; if you're tempted to import this from a service or controller,
 * that's a sign the operation belongs in a migration, not in request-time code.
 */
export function createMigrationConnection(): Sequelize {
  const env = validateEnv(process.env);

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
