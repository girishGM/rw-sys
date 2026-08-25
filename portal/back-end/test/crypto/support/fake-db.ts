/**
 * T-016 unit-test support — an in-memory stand-in for the one `Sequelize` instance the
 * crypto core talks to.
 *
 * **What this double is and is not for.** It exists so that every *branch* of
 * `KeyRegistryService` and `RotateKeysCommand` — including the ones that only fire on a
 * malformed row, an interrupted batch or a non-converging loop — can be driven
 * deterministically and hit the task's 100% coverage bar. It is explicitly **not** evidence
 * that the SQL those classes emit is correct: it recognises the handful of statement shapes
 * they produce and evaluates them itself. Real SQL, real constraints, real `starts_with()`
 * and a real 10,000-row rotation are covered by `test/crypto/*.e2e-spec.ts` against the
 * actual Postgres instance. Both halves are required; neither substitutes for the other.
 *
 * `transaction()` snapshots and restores the affected tables, so a throw inside a batch
 * really does undo that batch's writes — which is what makes the TC-17 interruption test
 * mean something rather than just not crashing.
 */
import type { Sequelize } from 'sequelize-typescript';

export interface FakeKeyRow {
  kid: string;
  purpose: string;
  algorithm: string;
  key_ref: string;
  status: string;
}

export type FakeRow = Record<string, unknown>;

/** Thrown by `FakeDb` when a test drives it with SQL it was not taught to understand. */
export class UnrecognisedSqlError extends Error {
  constructor(sql: string) {
    super(`FakeDb does not model this statement:\n${sql}`);
    this.name = 'UnrecognisedSqlError';
  }
}

interface QueryOptions {
  replacements?: Record<string, unknown>;
}

export class FakeDb {
  /** `reward_portal.encryption_keys`, modelled explicitly because its shape is fixed. */
  keyRows: FakeKeyRow[] = [];

  /** Every other table, keyed by the schema-qualified name used in the SQL. */
  tables = new Map<string, FakeRow[]>();

  /** Every statement executed, in order — used to assert on locking and batching. */
  readonly statements: string[] = [];

  /** Set to make the Nth `transaction()` call throw part-way through (TC-17). */
  failTransactionAtIndex: number | null = null;

  /** Set to make the key-registry SELECT reject, e.g. to model an unavailable database. */
  failKeyQueryWith: Error | null = null;

  private transactionCount = 0;

  setTable(name: string, rows: FakeRow[]): void {
    this.tables.set(
      name,
      rows.map((r) => ({ ...r })),
    );
  }

  getTable(name: string): FakeRow[] {
    const rows = this.tables.get(name);
    if (rows === undefined) throw new Error(`FakeDb has no table '${name}'`);
    return rows;
  }

  /** Cast helper — the production classes take a real `Sequelize`. */
  asSequelize(): Sequelize {
    return this as unknown as Sequelize;
  }

  async transaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
    const index = this.transactionCount;
    this.transactionCount += 1;

    const snapshot = new Map<string, FakeRow[]>();
    for (const [name, rows] of this.tables)
      snapshot.set(
        name,
        rows.map((r) => ({ ...r })),
      );
    const keySnapshot = this.keyRows.map((r) => ({ ...r }));

    try {
      const result = await fn({});
      if (this.failTransactionAtIndex === index) {
        throw new Error(`simulated failure in transaction #${index}`);
      }
      return result;
    } catch (err) {
      // Model a real ROLLBACK: everything this transaction wrote is undone.
      this.tables = snapshot;
      this.keyRows = keySnapshot;
      throw err;
    }
  }

  async query<T>(sql: string, options: QueryOptions = {}): Promise<T[]> {
    this.statements.push(sql);
    const replacements = options.replacements ?? {};
    const normalised = sql.replace(/\s+/g, ' ').trim();

    if (normalised.includes('FROM reward_portal.encryption_keys')) {
      return this.selectKeys(normalised, replacements) as T[];
    }
    if (normalised.startsWith('UPDATE reward_portal.encryption_keys')) {
      return this.updateKeys(normalised, replacements) as T[];
    }
    if (normalised.startsWith('SELECT count(*)::text AS count FROM ')) {
      return this.count(normalised, replacements) as T[];
    }
    if (normalised.startsWith('SELECT ')) {
      return this.select(normalised, replacements) as T[];
    }
    if (normalised.startsWith('UPDATE ')) {
      return this.update(normalised, replacements) as T[];
    }
    throw new UnrecognisedSqlError(sql);
  }

  // --- reward_portal.encryption_keys -----------------------------------------------------

  private selectKeys(sql: string, replacements: Record<string, unknown>): unknown[] {
    if (this.failKeyQueryWith !== null) throw this.failKeyQueryWith;
    if (sql.includes('WHERE kid = :kid')) {
      const row = this.keyRows.find((r) => r.kid === replacements.kid);
      return row === undefined ? [] : [{ ...row }];
    }
    return this.keyRows.map((r) => ({ ...r }));
  }

  private updateKeys(sql: string, replacements: Record<string, unknown>): unknown[] {
    if (sql.includes(`SET status = 'rotating'`)) {
      for (const row of this.keyRows) {
        if (
          row.purpose === replacements.purpose &&
          row.status === 'active' &&
          row.kid !== replacements.kid
        ) {
          row.status = 'rotating';
        }
      }
      return [];
    }
    if (sql.includes(`SET status = 'active'`)) {
      for (const row of this.keyRows) if (row.kid === replacements.kid) row.status = 'active';
      return [];
    }
    if (sql.includes(`SET status = 'retired'`)) {
      for (const row of this.keyRows) if (row.kid === replacements.kid) row.status = 'retired';
      return [];
    }
    throw new UnrecognisedSqlError(sql);
  }

  // --- generic rotation-target statements ------------------------------------------------

  private count(sql: string, replacements: Record<string, unknown>): unknown[] {
    const table = matchOrThrow(sql, /FROM ([a-z_][a-z0-9_.]*)/, 'table');
    const rows = this.getTable(table).filter((row) => evaluatePrefixWhere(sql, row, replacements));
    return [{ count: String(rows.length) }];
  }

  private select(sql: string, replacements: Record<string, unknown>): unknown[] {
    const projection = matchOrThrow(sql, /^SELECT (.+?) FROM /, 'projection')
      .split(',')
      .map((c) => c.trim());
    const table = matchOrThrow(sql, / FROM ([a-z_][a-z0-9_.]*)/, 'table');
    const orderBy = matchOrThrow(sql, / ORDER BY ([a-z_][a-z0-9_]*)/, 'order by');
    const limit = Number(replacements.limit);

    return this.getTable(table)
      .filter((row) => evaluatePrefixWhere(sql, row, replacements))
      .sort((a, b) => compareScalar(a[orderBy], b[orderBy]))
      .slice(0, limit)
      .map((row) => Object.fromEntries(projection.map((c) => [c, row[c]])));
  }

  private update(sql: string, replacements: Record<string, unknown>): unknown[] {
    const table = matchOrThrow(sql, /^UPDATE ([a-z_][a-z0-9_.]*) SET /, 'table');
    const assignments = matchOrThrow(sql, / SET (.+?) WHERE /, 'assignments');
    const pkColumn = matchOrThrow(sql, / WHERE ([a-z_][a-z0-9_]*) = :pk/, 'pk column');

    const pairs = assignments.split(',').map((piece) => {
      const [column, bind] = piece.split('=').map((s) => s.trim());
      return { column, bind: bind.replace(/^:/, '') };
    });

    for (const row of this.getTable(table)) {
      if (row[pkColumn] !== replacements.pk) continue;
      for (const { column, bind } of pairs) row[column] = replacements[bind];
    }
    return [];
  }
}

/**
 * Evaluates the `(col IS NOT NULL AND [NOT ]starts_with(col, :prefix)) OR ...` shape that
 * `rotate-keys.command.ts` builds — the only WHERE clause the rotation queries produce.
 */
function evaluatePrefixWhere(
  sql: string,
  row: FakeRow,
  replacements: Record<string, unknown>,
): boolean {
  const clauses = [
    ...sql.matchAll(
      /\(([a-z_][a-z0-9_]*) IS NOT NULL AND (NOT )?starts_with\([a-z_][a-z0-9_]*, :prefix\)\)/g,
    ),
  ];
  if (clauses.length === 0) throw new UnrecognisedSqlError(sql);

  const prefix = String(replacements.prefix);
  return clauses.some(([, column, negated]) => {
    const value = row[column];
    if (value === null || value === undefined) return false;
    const startsWith = String(value).startsWith(prefix);
    return negated === undefined ? startsWith : !startsWith;
  });
}

function matchOrThrow(sql: string, pattern: RegExp, what: string): string {
  const match = sql.match(pattern);
  if (match === null) throw new Error(`FakeDb could not find the ${what} in:\n${sql}`);
  return match[1];
}

function compareScalar(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}
