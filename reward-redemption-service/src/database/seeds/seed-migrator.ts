import path from 'node:path';
import { Umzug, SequelizeStorage } from 'umzug';
import type { Sequelize } from 'sequelize-typescript';

/**
 * T-RR-046. A second, independent Umzug instance for this task's own demo/seed data —
 * deliberately its own chain, never folded into `src/database/migrations/**`
 * (`agent-rr-foundation`'s own file scope, R3 in `AGENT-PROTOCOL.md` — this file only *imports*
 * `src/database/umzug.ts`/`migration-connection.ts` as read-only patterns/utilities, never edits
 * either).
 *
 * Same shape as `src/database/umzug.ts`'s own `createMigrator` (programmatic Umzug 3 config,
 * testable up/down, runnable from a CLI, no global state) but:
 *   - points at `src/database/seeds/*.seed.ts` (this directory) instead of
 *     `src/database/migrations/*.ts`;
 *   - tracks applied state in its own meta table, `reward_redemption.seed_migrations`, never
 *     `reward_redemption.migrations` — the two chains are deliberately independent, so a schema
 *     migration's own `db:migrate`/`db:rollback` round-trip (`AGENT-PROTOCOL.md` §4) keeps working
 *     whether or not demo data has ever been seeded, and this task's own seed data can be
 *     inserted/removed without disturbing Umzug's bookkeeping of which *schema* migrations have
 *     run (or vice versa).
 *
 * The compiled-vs-source glob-extension concern `umzug.ts`'s own `migrationGlobPattern` documents
 * applies here too (a `.ts` glob matches nothing once a build has emitted `.js` siblings), but
 * that helper is hardcoded to a `migrations/` sub-path (see its own source), so this file
 * reimplements the same one-line idea for its own `seeds/` directory rather than importing it.
 */
export function seedGlobPattern(moduleFilename: string): string {
  return `*.seed${path.extname(moduleFilename)}`;
}

export function createSeedMigrator(sequelize: Sequelize) {
  return new Umzug({
    migrations: {
      glob: [seedGlobPattern(__filename), { cwd: __dirname }],
      resolve: ({ name, path: seedPath, context }) => {
        // Dynamic seed loading, same convention as umzug.ts's own migration resolver.
        // eslint-disable-next-line @typescript-eslint/no-var-requires -- T-RR-046
        const seed = require(seedPath!);
        return {
          name,
          up: async () => seed.up({ context }),
          down: async () => seed.down({ context }),
        };
      },
    },
    context: sequelize,
    storage: new SequelizeStorage({
      sequelize,
      schema: 'reward_redemption',
      tableName: 'seed_migrations',
    }),
    logger: undefined,
  });
}
