#!/usr/bin/env node
/**
 * The migration CLI — `npm run db:migrate` (up), `npm run db:rollback` (down, `-- --all` for
 * a full teardown), `npm run db:migrate:status`. Always connects as the privileged migration
 * role (migration-connection.ts), never the app runtime role.
 *
 * Bootstraps `CREATE SCHEMA IF NOT EXISTS realtime_activity_processing` before constructing
 * Umzug's own `SequelizeStorage`, because that storage's meta table lives IN
 * `realtime_activity_processing` — on a genuinely fresh database, the schema can't exist before
 * the first migration runs, so Umzug's own bookkeeping can't be set up before it either. This
 * one statement is deliberately duplicated with `001_create_schema`'s own `up()` (which is what
 * actually gets recorded as "applied") — both are `IF NOT EXISTS`, so running it twice is free.
 * Mirrors `promo-code-service/src/database/cli/migrate.ts` verbatim in shape.
 */
/* eslint-disable no-console -- T-RAP-002: this is a CLI script; printing status IS its job. */
import 'reflect-metadata';
import path from 'node:path';
import dotenv from 'dotenv';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '../migration-connection';
import { createMigrator } from '../umzug';

/**
 * This CLI runs standalone, outside Nest's bootstrap — `@nestjs/config`'s own `envFilePath`
 * loading (config.module.ts) never runs here, so the same precedence is replicated by hand:
 * `.env.local` > `.env.<NODE_ENV>` > `.env`, first one found wins (dotenv never overwrites a
 * variable already loaded).
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

  const command = process.argv[2];
  if (!command || !['up', 'down', 'status'].includes(command)) {
    console.error('Usage: migrate.ts <up|down|status> [--all]');
    process.exit(1);
  }

  const sequelize = createMigrationConnection();
  try {
    await sequelize.authenticate();
    await sequelize.query('CREATE SCHEMA IF NOT EXISTS realtime_activity_processing;', {
      type: QueryTypes.RAW,
    });

    const migrator = createMigrator(sequelize);

    if (command === 'status') {
      const executed = await migrator.executed();
      const pending = await migrator.pending();
      console.log(`\n  Applied (${executed.length}):`);
      executed.forEach((m) => console.log(`    ✓ ${m.name}`));
      console.log(`\n  Pending (${pending.length}):`);
      pending.forEach((m) => console.log(`    · ${m.name}`));
      console.log();
      return;
    }

    if (command === 'up') {
      const applied = await migrator.up();
      console.log(`\n  ✓ Applied ${applied.length} migration(s):`);
      applied.forEach((m) => console.log(`    ${m.name}`));
      console.log();
      return;
    }

    if (command === 'down') {
      const rollbackAll = process.argv.includes('--all');
      const reverted = rollbackAll ? await migrator.down({ to: 0 }) : await migrator.down();
      console.log(
        `\n  ✓ Rolled back ${reverted.length} migration(s)${rollbackAll ? ' (--all)' : ''}:`,
      );
      reverted.forEach((m) => console.log(`    ${m.name}`));

      // A full `--all` teardown also drops the schema itself — deliberately done here, AFTER
      // Umzug has finished recording every migration (including 001) as reverted, not inside
      // 001's own down() (see that file's own comment: Umzug's SequelizeStorage bookkeeping
      // table lives IN realtime_activity_processing.migrations, so dropping the schema mid-chain
      // breaks Umzug's own ability to record 001 reverted). `pgcrypto` is left installed — it's
      // effectively global to the database, not owned by this one schema.
      if (rollbackAll) {
        await sequelize.query('DROP SCHEMA IF EXISTS realtime_activity_processing CASCADE;', {
          type: QueryTypes.RAW,
        });
        console.log('  ✓ Dropped realtime_activity_processing schema (--all)\n');
      } else {
        console.log();
      }
      return;
    }
  } finally {
    await sequelize.close();
  }
}

main().catch((err) => {
  console.error('\n  ✗ Migration failed:\n');
  console.error(err);
  process.exit(1);
});
