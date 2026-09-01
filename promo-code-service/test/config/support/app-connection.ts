/**
 * T-PC-010 test support. Builds a Postgres connection authenticated as the real,
 * least-privilege `promo_code_app` role (never the migration role) — the same real-Postgres
 * testing convention `test/database/migrations.spec.ts`'s own `TC-11`/`TC-12` describe block
 * already established for this schema (`AGENT-PROTOCOL.md` §3: "assert the observable
 * property, not the implementation string" — these specs run real scoped SQL against a real
 * database rather than mocking the repository layer).
 *
 * `DB_APP_USERNAME`/`DB_APP_PASSWORD`/`DB_HOST`/`DB_PORT`/`DB_NAME` are populated by
 * `test/database/env.setup.ts` (`.env.development`) before this file is ever imported —
 * `package.json`'s `jest.setupFiles` runs ahead of every test file's own imports.
 *
 * `onQuery` is optional and only used by the verification-step-4 test (capturing generated SQL
 * to assert every `list(...)` query is `tenant_id`-scoped) — every other test passes nothing
 * and gets ordinary silent logging (`logging: false`), matching this project's existing
 * connection-building convention (`src/database/migration-connection.ts`).
 */
import { Sequelize } from 'sequelize-typescript';

export function createAppTestConnection(onQuery?: (sql: string) => void): Sequelize {
  return new Sequelize({
    dialect: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    username: process.env.DB_APP_USERNAME,
    password: process.env.DB_APP_PASSWORD,
    logging: onQuery ? (sql: string) => onQuery(sql) : false,
  });
}
