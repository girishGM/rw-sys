/**
 * T-040 unit-test support — in-memory stand-ins for `NotificationsService`'s dependencies.
 *
 * Same rationale as `test/trace/support/trace-doubles.ts` (T-045): the property under test in
 * `notifications.service.spec.ts` is *which query* each method issues (does it always carry
 * `userId`? does `update` return 0 for a mismatched row?), not "the real database enforced the
 * scope" — that is `notifications.e2e-spec.ts`'s job, against the real schema and the real,
 * already-shipped `scope-strategy.ts`.
 */
import type {
  Attributes,
  CountOptions,
  FindOptions,
  Model,
  ModelStatic,
  UpdateOptions,
} from 'sequelize';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import type {
  NotificationInsert,
  NotificationStore,
} from '@/modules/notifications/notifications.repository';

export interface RecordedCall {
  readonly method: string;
  readonly model: string;
  readonly options: unknown;
  readonly values?: unknown;
}

/** A `ScopedRepository` double exposing only the methods `NotificationsService` calls. */
export class FakeScopedRepository {
  readonly calls: RecordedCall[] = [];
  rows: Record<string, unknown>[] = [];
  /** Overrides the row count `update()` reports as affected, keyed by call index. `null` uses the
   * default (matches `rows` by `id`/`userId`, when both are present in the caller's `where`). */
  nextUpdateAffected: number | null = null;

  async listAll<M extends Model>(model: ModelStatic<M>, options: FindOptions = {}): Promise<M[]> {
    this.calls.push({ method: 'listAll', model: model.name, options });
    const filtered = applyWhere(this.rows, options.where as Record<string, unknown> | undefined);
    const offset = typeof options.offset === 'number' ? options.offset : 0;
    const limit = typeof options.limit === 'number' ? options.limit : filtered.length;
    return filtered.slice(offset, offset + limit) as unknown as M[];
  }

  async count<M extends Model>(
    model: ModelStatic<M>,
    options: Omit<CountOptions<Attributes<M>>, 'group'> = {},
  ): Promise<number> {
    this.calls.push({ method: 'count', model: model.name, options });
    return applyWhere(this.rows, options.where as Record<string, unknown> | undefined).length;
  }

  async update<M extends Model>(
    model: ModelStatic<M>,
    values: Partial<Attributes<M>>,
    options: UpdateOptions<Attributes<M>>,
  ): Promise<number> {
    this.calls.push({ method: 'update', model: model.name, options, values });
    if (this.nextUpdateAffected !== null) return this.nextUpdateAffected;

    const matched = applyWhere(this.rows, options.where as Record<string, unknown> | undefined);
    for (const row of matched) Object.assign(row, values);
    return matched.length;
  }

  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}

function applyWhere(
  rows: Record<string, unknown>[],
  where: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  if (where === undefined) return rows;
  return rows.filter((row) =>
    Object.entries(where).every(([key, expected]) => row[key] === expected),
  );
}

export function asScopedRepository(fake: FakeScopedRepository): ScopedRepository {
  return fake as unknown as ScopedRepository;
}

/** A `NotificationStore` double, recording every insert attempt. */
export class FakeNotificationStore implements NotificationStore {
  readonly inserted: NotificationInsert[] = [];
  /** When set, `insert()` rejects with this — simulating the live `fk_un_user` failure. */
  failWith: Error | null = null;

  async insert(row: NotificationInsert): Promise<void> {
    if (this.failWith !== null) throw this.failWith;
    this.inserted.push(row);
  }
}
