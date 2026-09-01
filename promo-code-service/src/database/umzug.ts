import path from 'node:path';
import { Umzug, SequelizeStorage } from 'umzug';
import type { Sequelize } from 'sequelize-typescript';

/**
 * The migration glob must match whatever extension the migration files actually have *in the
 * directory this module itself is running from* — `.ts` under `ts-node` (every task's own
 * `npm run db:migrate`/`db:rollback`), `.js` once `nest build`/`tsc` has compiled this file to
 * `dist/database/umzug.js` and the sibling `migrations/*.ts` files to `dist/database/migrations/
 * *.js` (a production container: `node dist/main.js`). A glob hard-coded to `migrations/*.ts`
 * matches nothing in the compiled case — Umzug then reports zero pending migrations and
 * `migrate up` exits 0 having done nothing, indistinguishable from a genuinely up-to-date
 * database. `require()` already resolves either extension (`resolve()` below), so the only
 * thing that needs to track "am I running compiled or source" is the glob itself — `__filename`
 * of *this* module is the one fact that's always true at runtime regardless of how it got
 * loaded. Exported so it's independently testable without a filesystem or a database.
 */
export function migrationGlobPattern(moduleFilename: string): string {
  return `migrations/*${path.extname(moduleFilename)}`;
}

/**
 * Programmatic Umzug 3 config — testable up/down, runnable from a CLI, no global state
 * (matches portal/back-end's own `src/database/umzug.ts` convention, ARCHITECTURE.md §4). The
 * meta table lives in `promo_code`, never `reward_config`/`reward_portal` (R1/R0) —
 * bootstrapping that schema into existence is the CLI's job (`cli/migrate.ts`), since the meta
 * table's own schema can't exist before the first migration runs on a genuinely fresh database.
 *
 * Migration filenames are numbered (`001_...`, `002_...`) so ordering is deterministic — this
 * service has exactly one agent (`agent-promo-foundation`) authoring this migration chain, so
 * a task-id prefix (the portal's own convention, needed there because many agents' migrations
 * interleave) isn't needed here.
 */
export function createMigrator(sequelize: Sequelize) {
  return new Umzug({
    migrations: {
      glob: [migrationGlobPattern(__filename), { cwd: __dirname }],
      resolve: ({ name, path: migrationPath, context }) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires -- dynamic migration loading
        const migration = require(migrationPath!);
        return {
          name,
          up: async () => migration.up({ context }),
          down: async () => migration.down({ context }),
        };
      },
    },
    context: sequelize,
    storage: new SequelizeStorage({
      sequelize,
      schema: 'promo_code',
      tableName: 'migrations',
    }),
    logger: undefined,
  });
}

export const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
