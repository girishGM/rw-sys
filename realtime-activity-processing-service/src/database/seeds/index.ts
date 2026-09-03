#!/usr/bin/env node
/**
 * T-RAP-003 — `npm run db:seed` entrypoint. Runs all three seeds (01-DATABASE.md §1/§10/§11)
 * against an already-migrated database, in dependency order (`field_encryption_config`/
 * `service_config` have no ordering dependency on each other or on `campaign_config_snapshot`;
 * run sequentially anyway, matching `promo-code-service`'s own seed CLI shape, since a seed
 * script's own runtime cost is never the bottleneck here).
 *
 * Connects as `DB_APP_*` (`rap_app`), not the privileged migration role — seeding is plain DML
 * (`INSERT`) against this service's own schema, exactly the shape of operation the
 * least-privilege runtime role is meant to perform (AGENT-PROTOCOL.md R1; `rap_app` already has
 * SELECT/INSERT/UPDATE/DELETE on every table in this schema, T-RAP-002's own
 * `014_create_rap_app_role` migration) — there is no DDL here that would require the migration
 * role. Mirrors `promo-code-service/src/database/seeds/001_seed_demo_promo_code_configs.ts`'s own
 * `main()`/env-loading shape.
 */
import 'reflect-metadata';
import path from 'node:path';
import dotenv from 'dotenv';
import { Sequelize } from 'sequelize-typescript';
import { validateConfig } from '../../config/config.schema';
import { seedFieldEncryptionConfig } from './001_seed_field_encryption_config';
import { seedServiceConfig } from './002_seed_service_config';
import { seedCampaignConfigSnapshot } from './003_seed_campaign_config_snapshot';

/**
 * Runs every seed against an already-connected Sequelize instance — exported so
 * `test/database/seeds.spec.ts` can call it directly against a real Postgres connection
 * (AGENT-PROTOCOL.md §3: assert the observable, DB-enforced property, not a mocked one) without
 * spawning a child process.
 */
export async function runSeeds(sequelize: Sequelize): Promise<void> {
  await seedFieldEncryptionConfig(sequelize);
  await seedServiceConfig(sequelize);
  await seedCampaignConfigSnapshot(sequelize);
}

/**
 * Same `.env.local` > `.env.<NODE_ENV>` > `.env` precedence `src/database/cli/migrate.ts` uses —
 * this script also runs standalone via `ts-node`, outside Nest's own `ConfigModule` bootstrap, so
 * that loading has to be replicated by hand here too.
 */
function loadEnvFiles(): void {
  const serviceRoot = path.join(__dirname, '..', '..', '..');
  dotenv.config({ path: path.join(serviceRoot, '.env.local'), quiet: true });
  dotenv.config({
    path: path.join(serviceRoot, `.env.${process.env.NODE_ENV || 'development'}`),
    quiet: true,
  });
  dotenv.config({ path: path.join(serviceRoot, '.env'), quiet: true });
}

async function main(): Promise<void> {
  loadEnvFiles();
  const env = validateConfig(process.env);

  const sequelize = new Sequelize({
    dialect: 'postgres',
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    username: env.DB_APP_USERNAME,
    password: env.DB_APP_PASSWORD,
    logging: false,
    dialectOptions: env.DB_SSL ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  });

  try {
    await sequelize.authenticate();
    await runSeeds(sequelize);
    // eslint-disable-next-line no-console -- T-RAP-003: this is a CLI entrypoint; printing status IS its job.
    console.log('\n  ✓ Seeded field_encryption_config, service_config, campaign_config_snapshot\n');
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console -- T-RAP-003: CLI entrypoint failure reporting.
    console.error('\n  ✗ Seed failed:\n');
    // eslint-disable-next-line no-console -- T-RAP-003: CLI entrypoint failure reporting.
    console.error(err);
    process.exit(1);
  });
}
