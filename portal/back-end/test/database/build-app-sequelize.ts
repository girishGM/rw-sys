/**
 * T-003 test support — builds a `Sequelize` instance connected as the least-privilege
 * `reward_app` role (never the migration role) with every T-003 model registered, mirroring
 * `sequelize.provider.ts`'s factory without going through Nest DI (these are plain Jest
 * e2e specs against a real Postgres instance, same convention as T-002/T-005/T-006/T-007's
 * `test/database/*.e2e-spec.ts`). `env.schema.ts`'s `validateEnv` is reused so a missing
 * `.env.development` value fails the same way it would in the real app.
 */
import { Sequelize } from 'sequelize-typescript';
import { validateEnv } from '@/config/env.schema';
import { redactSql } from '@/database/logging/redact-sql';
import { PORTAL_MODELS } from '@/database/portal-models';
import { REWARD_CONFIG_MODELS } from '@/database/models';

export function buildAppSequelize(options?: { captureLogLines?: string[] }): Sequelize {
  const env = validateEnv(process.env);

  return new Sequelize({
    dialect: 'postgres',
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    username: env.DB_APP_USERNAME,
    password: env.DB_APP_PASSWORD,
    dialectOptions: env.DB_SSL ? { ssl: { require: true, rejectUnauthorized: false } } : {},
    pool: { max: 20, min: 2, idle: 10000, acquire: 30000 },
    define: { underscored: true, timestamps: true },
    logging: (sql: string) => {
      const redacted = redactSql(sql);
      options?.captureLogLines?.push(redacted);
    },
    models: [...PORTAL_MODELS, ...REWARD_CONFIG_MODELS],
  });
}
