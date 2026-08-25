/**
 * T-092 unit-test support — in-memory `ScopedRepository` double for `DashboardService`, same
 * rationale `test/merchant-portal/support/merchant-portal-doubles.ts` (T-039) and
 * `test/countries/support/countries-doubles.ts` (T-030) both give: the interesting behaviour
 * here is *which query each resolver issues, with which `where`, and what it does with the
 * rows/count that come back* — not "the real database enforced the scope", which
 * `common/scope/scope-strategy.ts` is already exhaustively tested for (T-013, 100% branch
 * coverage) and `dashboard.e2e-spec.ts` proves for real against the live database.
 *
 * Unlike `merchant-portal-doubles.ts`'s `FakeScopedRepository`, this double does **not**
 * interpret `where` at all — `count`/`listAll` simply return whatever was registered for that
 * model, and every test that cares about *which* rows a resolver asked for asserts the recorded
 * `where`/`order`/`limit` directly. `dashboard.service.ts` builds `where` clauses with `Op.ne`
 * and `Op.gte` that `merchant-portal-doubles.ts`'s `applyWhere` has no case for; re-deriving Op
 * semantics in a second, parallel fake is exactly the kind of drift-prone duplication this
 * module's own header warns against for `TenantsService#listTenantsWithoutCeiling`.
 */
import type { CountOptions, FindOptions, Model, ModelStatic } from 'sequelize';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';

export interface RecordedCall {
  readonly method: 'count' | 'listAll';
  readonly model: string;
  readonly options: unknown;
}

export class FakeScopedRepository {
  readonly calls: RecordedCall[] = [];

  private readonly countByModel = new Map<string, number>();
  private readonly rowsByModel = new Map<string, unknown[]>();

  setCount(model: ModelStatic<Model>, count: number): this {
    this.countByModel.set(model.name, count);
    return this;
  }

  setListRows(model: ModelStatic<Model>, rows: readonly unknown[]): this {
    this.rowsByModel.set(model.name, [...rows]);
    return this;
  }

  async count(model: ModelStatic<Model>, options: CountOptions = {}): Promise<number> {
    this.calls.push({ method: 'count', model: model.name, options });
    return this.countByModel.get(model.name) ?? 0;
  }

  async listAll<M extends Model>(model: ModelStatic<M>, options: FindOptions = {}): Promise<M[]> {
    this.calls.push({ method: 'listAll', model: model.name, options });
    return (this.rowsByModel.get(model.name) ?? []) as M[];
  }

  callsTo(method: 'count' | 'listAll', modelName?: string): RecordedCall[] {
    return this.calls.filter(
      (call) => call.method === method && (modelName === undefined || call.model === modelName),
    );
  }
}

export function asScopedRepository(fake: FakeScopedRepository): ScopedRepository {
  return fake as unknown as ScopedRepository;
}

export function actor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 42,
    sessionId: '00000000-0000-4000-8000-000000000000',
    role: 'super_admin',
    countryId: null,
    tenantId: null,
    merchantId: null,
    rbacVersion: 1,
    tokenId: '00000000-0000-4000-8000-000000000001',
    mustChangePassword: false,
    ...overrides,
  };
}
