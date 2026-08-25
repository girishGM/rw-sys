#!/usr/bin/env node
/**
 * The migration CLI — `npm run db:migrate|db:rollback|db:status`. Always connects as the
 * privileged migration role (migration-connection.ts), never the app runtime role.
 *
 * Bootstraps `CREATE SCHEMA IF NOT EXISTS reward_portal` before constructing Umzug's own
 * `SequelizeStorage`, because that storage's meta table lives IN `reward_portal`
 * (T-002 note 1) — on a genuinely fresh database, the schema can't exist before the first
 * migration runs, so Umzug's own bookkeeping can't be set up before it either. This one
 * statement is deliberately duplicated with T002_001's own `up()` (which is what actually
 * gets recorded as "applied") — both are `IF NOT EXISTS`, so running it twice is free.
 */
/* eslint-disable no-console -- T-002: this is a CLI script; printing status IS its job. */
import 'reflect-metadata';
import path from 'node:path';
import dotenv from 'dotenv';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '../migration-connection';
import { createMigrator } from '../umzug';

/**
 * This CLI runs standalone, outside Nest's bootstrap — @nestjs/config's own envFilePath
 * loading (config.module.ts) never runs here, so the same precedence is replicated by
 * hand: `.env.local` > `.env.<NODE_ENV>` > `.env`, first one found wins (dotenv never
 * overwrites a variable already loaded).
 */
function loadEnvFiles(): void {
  const backEndDir = path.join(__dirname, '..', '..', '..');
  dotenv.config({ path: path.join(backEndDir, '.env.local'), quiet: true });
  dotenv.config({
    path: path.join(backEndDir, `.env.${process.env.NODE_ENV || 'development'}`),
    quiet: true,
  });
  dotenv.config({ path: path.join(backEndDir, '.env'), quiet: true });
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
    await sequelize.query('CREATE SCHEMA IF NOT EXISTS reward_portal;', { type: QueryTypes.RAW });

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
      console.log();
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
