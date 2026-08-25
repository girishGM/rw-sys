/**
 * Minimal ambient declaration for the `pg` package, used only by
 * `first-run.e2e-spec.ts` in this directory.
 *
 * `back-end/package.json` does not list `@types/pg` (it is `T-001`'s file, outside this
 * task's grant — see `AGENT_SCOPES` in `project-plan/scripts/orchestrator.js`), and `pg`
 * itself ships no types. `e2e/` already depends on `@types/pg` for the identical need
 * (`e2e/utils/db.ts`/`localPostgres.ts`), but is a separate npm workspace with its own
 * `node_modules`, not reachable from here — see `first-run.e2e-spec.ts`'s own header for why
 * that file duplicates logic instead of importing across the workspace boundary. This
 * declares only the handful of members that file actually calls, not the whole `pg` API
 * surface — narrower than pulling in the real `@types/pg` package would be, and adds no
 * runtime dependency.
 */
declare module 'pg' {
  export interface QueryResultRow {
    [column: string]: unknown;
  }

  export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
    rows: R[];
  }

  export class Client {
    constructor(config: {
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
    });
    connect(): Promise<void>;
    query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values?: unknown[],
    ): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }
}
