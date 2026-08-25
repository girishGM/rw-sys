import path from 'node:path';
import { Umzug, SequelizeStorage } from 'umzug';
import type { Sequelize } from 'sequelize-typescript';

/**
 * T-079 fix. The migration glob must match whatever extension the migration files
 * actually have *in the directory this module itself is running from* — `.ts` under
 * `ts-node` (every task's own verification, `db:migrate`), `.js` once `tsc`/`nest build`
 * has compiled this file to `dist/database/umzug.js` and the sibling `migrations/*.ts`
 * files to `dist/database/migrations/*.js` (a production container: `node dist/main.js`
 * or, before this fix, `node dist/database/cli/migrate.js` run directly). A glob
 * hard-coded to `migrations/*.ts` matches nothing in the compiled case — Umzug then
 * reports zero pending migrations and `migrate up` exits 0 having done nothing,
 * indistinguishable from a genuinely up-to-date database (reproduced live: see
 * `project-plan/reports/T-079-...md`).
 *
 * `require()` already resolves either extension (`resolve()` below), so the only thing
 * that needs to track "am I running compiled or source" is the glob itself. `__filename`
 * of *this* module is the one fact that is always true at runtime regardless of how it
 * got loaded: `ts-node`/`ts-jest` register a `require` hook for `.ts` but leave
 * `__filename` pointing at the real `.ts` source path; plain `node` loading `tsc` output
 * sees the real `.js` path. Exported so it can be unit-tested without a filesystem or a
 * database (`umzug.spec.ts`) — proven, not assumed, for both cases.
 */
export function migrationGlobPattern(moduleFilename: string): string {
  return `migrations/*${path.extname(moduleFilename)}`;
}

/**
 * Programmatic Umzug 3 config (00-ARCHITECTURE.md §8: "testable up/down, runnable from
 * CI, no CLI/global state"). The meta table lives in `reward_portal`, never
 * `reward_config` (T-002 note 1) — bootstrapping that schema into existence is the
 * caller's job (see cli/migrate.ts), since the meta table's own schema can't exist before
 * the first migration runs on a genuinely fresh database.
 *
 * Migration filenames are prefixed with the owning task id (`T002_001_...`) so ordering is
 * deterministic across tasks and two agents can't collide on a bare sequence number
 * (05-EXECUTION-PLAN.md §3).
 */
export function createMigrator(sequelize: Sequelize) {
  return new Umzug({
    migrations: {
      glob: [migrationGlobPattern(__filename), { cwd: __dirname }],
      resolve: ({ name, path: migrationPath, context }) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
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
      schema: 'reward_portal',
      tableName: 'migrations',
    }),
    logger: undefined,
  });
}

export const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
