/**
 * T-040 unit-test support — in-memory `ScopedRepository` double for `AuditViewerService`. Same
 * rationale as `test/notifications/support/notifications-doubles.ts` and
 * `test/trace/support/trace-doubles.ts`: proves *which query* the service issues, not that the
 * real database enforces the scope — `audit-viewer.e2e-spec.ts` does that.
 */
import type { Attributes, CountOptions, FindOptions, Model, ModelStatic } from 'sequelize';
import type { ScopedRepository } from '@/common/scope/scoped.repository';

export interface RecordedCall {
  readonly method: string;
  readonly model: string;
  readonly options: unknown;
}

export class FakeScopedRepository {
  readonly calls: RecordedCall[] = [];
  rows: Record<string, unknown>[] = [];

  async listAll<M extends Model>(model: ModelStatic<M>, options: FindOptions = {}): Promise<M[]> {
    this.calls.push({ method: 'listAll', model: model.name, options });
    const filtered = applyWhere(this.rows, options.where);
    const offset = typeof options.offset === 'number' ? options.offset : 0;
    const limit = typeof options.limit === 'number' ? options.limit : filtered.length;
    return filtered.slice(offset, offset + limit) as unknown as M[];
  }

  async count<M extends Model>(
    model: ModelStatic<M>,
    options: Omit<CountOptions<Attributes<M>>, 'group'> = {},
  ): Promise<number> {
    this.calls.push({ method: 'count', model: model.name, options });
    return applyWhere(this.rows, options.where).length;
  }
}

function applyWhere(rows: Record<string, unknown>[], where: unknown): Record<string, unknown>[] {
  if (where === undefined) return rows;
  return rows.filter((row) => matches(row, where as Record<symbol | string, unknown>));
}

/** A tiny structural matcher for the shapes `campaignAuditWhere`/`portalAuditWhere` build:
 * `{ [Op.and]: [...] }`, plain equality clauses, and `{ [Op.gte]: … }` / `{ [Op.lte]: … }`
 * range clauses. Not a general Sequelize `where` evaluator — it only needs to understand the
 * clauses this module's own service ever constructs. */
function matches(row: Record<string, unknown>, where: Record<symbol | string, unknown>): boolean {
  for (const key of Reflect.ownKeys(where)) {
    const value = (where as Record<symbol, unknown>)[key as symbol];
    if (typeof key === 'symbol') {
      if (key.description === 'and') {
        const clauses = value as Record<string, unknown>[];
        if (!clauses.every((clause) => matches(row, clause))) return false;
      }
      continue;
    }

    const actual = row[key];
    if (isRangeClause(value)) {
      if (!matchesRange(actual, value)) return false;
    } else if (actual !== value) {
      return false;
    }
  }
  return true;
}

function isRangeClause(value: unknown): value is Record<symbol, Date> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getOwnPropertySymbols(value).length > 0 &&
    !Array.isArray(value)
  );
}

function matchesRange(actual: unknown, range: Record<symbol, Date>): boolean {
  if (!(actual instanceof Date)) return false;
  for (const symbol of Object.getOwnPropertySymbols(range)) {
    const bound = range[symbol];
    if (symbol.description === 'gte' && actual < bound) return false;
    if (symbol.description === 'lte' && actual > bound) return false;
  }
  return true;
}

export function asScopedRepository(fake: FakeScopedRepository): ScopedRepository {
  return fake as unknown as ScopedRepository;
}
