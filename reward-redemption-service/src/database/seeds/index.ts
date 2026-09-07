#!/usr/bin/env node
/**
 * T-RR-046. Demo/seed-data CLI — `npm run db:seed` (up), `npm run db:seed -- down` (rolls back
 * the most recently applied seed; `-- down --all` for every seed), `npm run db:seed -- status`.
 * `package.json`'s own `db:seed` script (added ahead of this task, per that file's owner
 * `agent-rr-foundation`) already points here — this task only supplies the implementation.
 *
 * Mirrors `src/database/cli/migrate.ts`'s own shape (read as a pattern, never edited — that file
 * is `agent-rr-foundation`'s own, R3), but drives `createSeedMigrator` (this task's own
 * `seed-migrator.ts`) against `src/database/seeds/*.seed.ts` instead of the schema-migration
 * chain, and never drops any schema on `--all` (there is no equivalent of `migrate.ts`'s own
 * `DROP SCHEMA ... CASCADE` here — this CLI only ever touches the specific demo rows its own seed
 * files inserted).
 *
 * Connects via the same privileged migration role `migrate.ts` uses
 * (`createMigrationConnection`), not the least-privilege `rr_app` runtime role — this task's own
 * seed data is inserted once, by an operator, not by request-time application code, and
 * `SequelizeStorage`'s own meta table (`reward_redemption.seed_migrations`) needs `CREATE TABLE`
 * privilege `rr_app` deliberately never has (`014_create_rr_app_role.ts`'s own header).
 */
/* eslint-disable no-console -- T-RR-046: this is a CLI script; printing status IS its job (same
   exception migrate.ts takes). */
import 'reflect-metadata';
import path from 'node:path';
import dotenv from 'dotenv';
import { createMigrationConnection } from '../migration-connection';
import { createSeedMigrator } from './seed-migrator';

/** Same precedence as `migrate.ts`'s own `loadEnvFiles` — this CLI runs standalone, outside
 * Nest's bootstrap, so `@nestjs/config`'s own `envFilePath` loading never runs here either. */
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

  const command = process.argv[2] || 'up';
  if (!['up', 'down', 'status'].includes(command)) {
    console.error('Usage: seeds/index.ts <up|down|status> [--all]');
    process.exit(1);
  }

  const sequelize = createMigrationConnection();
  try {
    await sequelize.authenticate();

    const seeder = createSeedMigrator(sequelize);

    if (command === 'status') {
      const executed = await seeder.executed();
      const pending = await seeder.pending();
      console.log(`\n  Seeded (${executed.length}):`);
      executed.forEach((m) => console.log(`    ✓ ${m.name}`));
      console.log(`\n  Pending (${pending.length}):`);
      pending.forEach((m) => console.log(`    · ${m.name}`));
      console.log();
      return;
    }

    if (command === 'up') {
      const applied = await seeder.up();
      console.log(`\n  ✓ Seeded ${applied.length} demo dataset(s):`);
      applied.forEach((m) => console.log(`    ${m.name}`));
      console.log();
      return;
    }

    if (command === 'down') {
      const rollbackAll = process.argv.includes('--all');
      const reverted = rollbackAll ? await seeder.down({ to: 0 }) : await seeder.down();
      console.log(
        `\n  ✓ Removed ${reverted.length} demo dataset(s)${rollbackAll ? ' (--all)' : ''}:`,
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
  console.error('\n  ✗ Seeding failed:\n');
  console.error(err);
  process.exit(1);
});
