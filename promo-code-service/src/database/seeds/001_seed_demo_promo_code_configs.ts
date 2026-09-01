#!/usr/bin/env node
/**
 * T-PC-003 — seeds a handful of demo `promo_code_config` rows so local dev/demo work has
 * realistic, non-empty data from day one of Wave 1 onward (task file "Objective").
 *
 * Deliberately separate from the numbered migration chain (`src/database/migrations/`,
 * driven by Umzug via `npm run db:migrate`): seed data is not schema, has no `down()`, and
 * `01-DATABASE.md`/this task's own "Rollback" section spell out a plain `DELETE ... WHERE
 * created_by = <demo actor>` instead of a reversible migration step. The `001_` prefix here is
 * this seed directory's own ordering scheme, unrelated to the migrations directory's numbering.
 *
 * Connects as `promo_code_app` (`DB_APP_*`), not the privileged migration role — seeding is
 * plain DML (`INSERT`) against this service's own schema, exactly the shape of operation the
 * least-privilege runtime role is meant to perform (AGENT-PROTOCOL.md R1); there is no DDL here
 * that would require the migration role.
 *
 * Idempotent via `ON CONFLICT (...) WHERE ... DO NOTHING` keyed on the exact same partial-unique
 * index the schema already enforces (`uc_promo_code_config_name`, `(tenant_id, name) WHERE
 * deleted_at IS NULL` — `01-DATABASE.md` §1 / `002_create_promo_code_config`), per implementation
 * note 2: this way the idempotency check can never drift out of sync with the real uniqueness
 * rule enforced everywhere else. Spelled out as `(tenant_id, name) WHERE deleted_at IS NULL`
 * rather than `ON CONFLICT ON CONSTRAINT uc_promo_code_config_name` — Postgres's `ON CONFLICT ON
 * CONSTRAINT` form only resolves a true table constraint (e.g. one added via `ADD CONSTRAINT`),
 * and this uniqueness rule is a partial *index* (`CREATE UNIQUE INDEX ... WHERE ...`), not a
 * constraint; `ON CONSTRAINT` against it fails at runtime with "constraint ... does not exist"
 * (confirmed against the real migrated schema while implementing this task).
 */
/* eslint-disable no-console -- T-PC-003: this is a CLI entrypoint; printing status IS its job. */
import 'reflect-metadata';
import path from 'node:path';
import dotenv from 'dotenv';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { validateConfig } from '../../config/config.schema';
import { DEMO_ACTOR_ID, DEMO_PROMO_CODE_CONFIGS } from './seed-data.constants';

/**
 * Runs the actual inserts against an already-connected Sequelize instance — exported so
 * `test/database/seed.spec.ts` can call it directly against a real Postgres connection (per
 * AGENT-PROTOCOL.md §3: assert the observable, DB-enforced property, not a mocked one) without
 * going through a child process.
 */
export async function seedDemoPromoCodeConfigs(sequelize: Sequelize): Promise<void> {
  for (const config of DEMO_PROMO_CODE_CONFIGS) {
    await sequelize.query(
      `INSERT INTO promo_code.promo_code_config
         (tenant_id, merchant_id, name, code_prefix, code_postfix, code_length, character_set,
          exclude_ambiguous_chars, reward_value_type, reward_value, reward_unit,
          max_redemptions_per_code, code_expiry_days, status, created_by, updated_by)
       VALUES
         (:tenant_id, :merchant_id, :name, :code_prefix, :code_postfix, :code_length,
          :character_set, :exclude_ambiguous_chars, :reward_value_type, :reward_value,
          :reward_unit, :max_redemptions_per_code, :code_expiry_days, :status, :created_by,
          :updated_by)
       ON CONFLICT (tenant_id, name) WHERE deleted_at IS NULL DO NOTHING`,
      {
        type: QueryTypes.RAW,
        replacements: {
          ...config,
          created_by: DEMO_ACTOR_ID,
          updated_by: DEMO_ACTOR_ID,
        },
      },
    );
  }
}

/**
 * Same `.env.local` > `.env.<NODE_ENV>` > `.env` precedence `src/database/cli/migrate.ts` uses
 * — this script also runs standalone via `ts-node`, outside Nest's own `ConfigModule` bootstrap,
 * so that loading has to be replicated by hand here too.
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
    await seedDemoPromoCodeConfigs(sequelize);
    console.log(`\n  ✓ Seeded ${DEMO_PROMO_CODE_CONFIGS.length} demo promo_code_config row(s)\n`);
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n  ✗ Seed failed:\n');
    console.error(err);
    process.exit(1);
  });
}
