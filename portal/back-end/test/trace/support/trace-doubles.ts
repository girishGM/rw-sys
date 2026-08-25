/**
 * T-045 unit-test support — in-memory stand-ins for `TraceService`'s three dependencies.
 *
 * Same rationale as `test/me/support/me-doubles.ts`: the property under test in `trace.service
 * .spec.ts` is which query each source received and how the four sources' results are combined,
 * not "the real database returned some rows" — that is `trace.e2e-spec.ts`'s job, against the
 * real schema.
 */
import type { FindOptions, Model, ModelStatic } from 'sequelize';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import type { ConfigFetchAdapter } from '@/modules/trace/adapters/config-fetch.adapter';
import type { LogStoreAdapter } from '@/modules/trace/adapters/log-store.adapter';
import type { RawLogLine } from '@/modules/trace/trace-assembly';

export interface RecordedListAllCall {
  readonly model: string;
  readonly options: FindOptions;
}

/** A `ScopedRepository` double exposing only the one method `TraceService` calls. */
export class FakeScopedRepository {
  readonly calls: RecordedListAllCall[] = [];
  readonly rows = new Map<string, unknown[]>();

  setRows(model: ModelStatic<Model>, rows: readonly unknown[]): this {
    this.rows.set(model.name, [...rows]);
    return this;
  }

  async listAll<M extends Model>(model: ModelStatic<M>, options: FindOptions = {}): Promise<M[]> {
    this.calls.push({ model: model.name, options });
    const all = (this.rows.get(model.name) ?? []) as M[];
    const limit = options.limit;
    return typeof limit === 'number' ? all.slice(0, limit) : all;
  }

  callsTo(modelName: string): RecordedListAllCall[] {
    return this.calls.filter((call) => call.model === modelName);
  }
}

export function asScopedRepository(fake: FakeScopedRepository): ScopedRepository {
  return fake as unknown as ScopedRepository;
}

/** A `LogStoreAdapter` double. `null` (the default) reproduces "adapter returned nothing to say
 * whether it is reachable" — set `.lines` to control the answer, or `.throwsOnFetch` to simulate
 * an adapter that does not honour its own "never throw" contract, which `TraceService` must not
 * depend on anyway. */
export class FakeLogStoreAdapter implements LogStoreAdapter {
  lines: readonly RawLogLine[] | null = null;
  lastRequestedLimit: number | null = null;

  async fetchLines(_correlationId: string, limit: number): Promise<readonly RawLogLine[] | null> {
    this.lastRequestedLimit = limit;
    return this.lines === null ? null : this.lines.slice(0, limit);
  }
}

export class FakeConfigFetchAdapter implements ConfigFetchAdapter {
  entries: readonly Record<string, unknown>[] | null = null;

  async fetchEntries(
    _correlationId: string,
    limit: number,
  ): Promise<readonly Record<string, unknown>[] | null> {
    return this.entries === null ? null : this.entries.slice(0, limit);
  }
}
