/**
 * The APP-RUNTIME database connection — always `DB_APP_*` (`reward_app`), never the
 * privileged migration role (see migration-connection.ts). T-003 registers every model
 * (both `reward_portal` and the covered `reward_config` tables) onto this connection via
 * the `models:` array below, resolved from `DatabaseModule`; T-002's own scope was the
 * connection itself plus the migrations that create what it's allowed to touch.
 *
 * Deliberately built on `sequelize-typescript` directly (the plan's stack choice,
 * 00-ARCHITECTURE.md §8) rather than the separate `@nestjs/sequelize` package, via a plain
 * factory provider — one dependency, not two doing overlapping jobs.
 *
 * Config notes, all per 01-DATABASE.md §6:
 *  - Every model declares its own `schema:` explicitly (reward_config vs reward_portal) —
 *    this one connection serves both, since they're schemas in the same `reward_system`
 *    database, not separate databases.
 *  - `logging` redacts bind parameters. Sequelize's default logger prints full SQL
 *    including values, which would put password hashes and tokens straight into logs.
 *  - Pool sized per the plan's stated defaults.
 */
import { Sequelize } from 'sequelize-typescript';
import { ConfigService } from '@nestjs/config';
import type { Provider } from '@nestjs/common';
import type { Env } from '@/config/env.schema';
import { redactSql } from './logging/redact-sql';
import { PORTAL_MODELS } from './portal-models';
import { REWARD_CONFIG_MODELS } from './models';

export const SEQUELIZE = Symbol('SEQUELIZE');

export const sequelizeProvider: Provider = {
  provide: SEQUELIZE,
  inject: [ConfigService],
  useFactory: async (config: ConfigService<Env, true>) => {
    const nodeEnv = config.get('NODE_ENV', { infer: true });
    const dbSsl = config.get('DB_SSL', { infer: true });
    if (!dbSsl && nodeEnv !== 'development' && nodeEnv !== 'test') {
      throw new Error('DB_SSL must be true in any non-local environment (02-SECURITY.md).');
    }

    const sequelize = new Sequelize({
      dialect: 'postgres',
      host: config.get('DB_HOST', { infer: true }),
      port: config.get('DB_PORT', { infer: true }),
      database: config.get('DB_NAME', { infer: true }),
      username: config.get('DB_APP_USERNAME', { infer: true }),
      password: config.get('DB_APP_PASSWORD', { infer: true }),
      dialectOptions: dbSsl ? { ssl: { require: true, rejectUnauthorized: false } } : {},
      pool: { max: 20, min: 2, idle: 10000, acquire: 30000 },
      define: { underscored: true, timestamps: true },
      // eslint-disable-next-line no-console -- this IS the logger; redaction happens above.
      logging: (sql: string) => console.debug(redactSql(sql)),
      models: [...PORTAL_MODELS, ...REWARD_CONFIG_MODELS],
    });

    await sequelize.authenticate();
    return sequelize;
  },
};
