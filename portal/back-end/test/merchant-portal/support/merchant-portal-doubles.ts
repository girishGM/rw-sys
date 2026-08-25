/**
 * T-039 unit-test support — in-memory `ScopedRepository` double for `MerchantPortalService`.
 * Same rationale `test/merchants/support/merchants-doubles.ts` (T-036) and
 * `test/audit/support/audit-viewer-doubles.ts` (T-040) both give: the interesting behaviour here
 * is a set of *decisions* — which model, which `where`, whether `assertRole` fired before any
 * query ran, how a `findByPkOrFail`/`findOneOrFail` miss surfaces — not "the real database
 * enforced the scope", which `common/scope/scope-strategy.ts` is already exhaustively tested for
 * (T-013, 100% branch coverage) and `merchant-portal.e2e-spec.ts` proves for this module's own
 * tables against the real database (TC-2's headline isolation claim above all).
 */
import { Op, type CountOptions, type FindOptions, type Model, type ModelStatic } from 'sequelize';
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import type { Activity } from '@/database/models/activity.model';
import type { CampaignMerchant } from '@/database/models/campaign-merchant.model';
import type { MerchantActivity } from '@/database/models/merchant-activity.model';
import type { TenantCampaign } from '@/database/models/tenant-campaign.model';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';

export interface RecordedCall {
  readonly method: string;
  readonly model: string;
  readonly options: unknown;
}

/**
 * A `ScopedRepository` that answers from memory, keyed by model name. `listAll`/`count` filter
 * the rows registered via {@link setListRows} against a `where` clause understanding plain
 * equality and `{ [Op.in]: [...] }` — the only two shapes `merchant-portal.service.ts` ever
 * builds (`MERCHANT_VISIBLE_CAMPAIGN_STATUSES`'s `Op.in`, and the `campaignId`/`id` equality and
 * `Op.in` clauses the detail/activity lookups use).
 */
export class FakeScopedRepository {
  readonly calls: RecordedCall[] = [];

  private readonly rows = new Map<string, unknown[]>();
  private readonly byPk = new Map<string, unknown>();
  private readonly byOne = new Map<string, unknown>();

  setListRows(model: ModelStatic<Model>, rows: readonly unknown[]): this {
    this.rows.set(model.name, [...rows]);
    return this;
  }

  /** `row: null` reproduces the real class's 404-on-absent-or-out-of-scope behaviour. */
  setByPk(model: ModelStatic<Model>, row: unknown): this {
    this.byPk.set(model.name, row);
    return this;
  }

  setByOne(model: ModelStatic<Model>, row: unknown): this {
    this.byOne.set(model.name, row);
    return this;
  }

  async listAll<M extends Model>(model: ModelStatic<M>, options: FindOptions = {}): Promise<M[]> {
    this.record('listAll', model, options);
    const rows = (this.rows.get(model.name) ?? []) as M[];
    return applyWhere(rows, (options as { where?: unknown }).where);
  }

  async count(model: ModelStatic<Model>, options: CountOptions = {}): Promise<number> {
    this.record('count', model, options);
    const rows = this.rows.get(model.name) ?? [];
    return applyWhere(rows, (options as { where?: unknown }).where).length;
  }

  async findByPkOrFail<M extends Model>(
    model: ModelStatic<M>,
    id: unknown,
    options: FindOptions = {},
  ): Promise<M> {
    this.record('findByPkOrFail', model, { id, ...options });
    const row = this.byPk.get(model.name);
    if (row === undefined || row === null) throw new ScopeViolationError();
    return row as M;
  }

  async findOneOrFail<M extends Model>(
    model: ModelStatic<M>,
    options: FindOptions = {},
  ): Promise<M> {
    this.record('findOneOrFail', model, options);
    const row = this.byOne.get(model.name);
    if (row === undefined || row === null) throw new ScopeViolationError();
    return row as M;
  }

  private record(method: string, model: ModelStatic<Model>, options: unknown): void {
    this.calls.push({ method, model: model.name, options });
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}

function applyWhere<T>(rows: T[], where: unknown): T[] {
  if (where === null || typeof where !== 'object') return rows;
  const entries = Object.entries(where as Record<string, unknown>);
  if (entries.length === 0) return rows;
  return rows.filter((row) =>
    entries.every(([key, value]) => matchesClause((row as Record<string, unknown>)[key], value)),
  );
}

function matchesClause(actual: unknown, expected: unknown): boolean {
  if (
    expected !== null &&
    typeof expected === 'object' &&
    Object.getOwnPropertySymbols(expected).includes(Op.in)
  ) {
    const allowed = (expected as Record<symbol, unknown>)[Op.in];
    return Array.isArray(allowed) && allowed.includes(actual);
  }
  return actual === expected;
}

export function asScopedRepository(fake: FakeScopedRepository): ScopedRepository {
  return fake as unknown as ScopedRepository;
}

export function actor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 900,
    sessionId: '00000000-0000-4000-8000-000000000000',
    role: 'merchant',
    countryId: 1,
    tenantId: 10,
    merchantId: 100,
    rbacVersion: 1,
    tokenId: '00000000-0000-4000-8000-000000000001',
    mustChangePassword: false,
    ...overrides,
  };
}

/** A `tenant_campaigns` row shaped exactly as `toMerchantCampaignListItemDto` expects to read it. */
export function campaignRow(overrides: Partial<TenantCampaign> = {}): TenantCampaign {
  return {
    id: 1,
    tenantId: 10,
    campaignCode: 'CMP-1',
    name: 'Summer Splash',
    description: null,
    region: 'EU',
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-02-01T00:00:00.000Z'),
    status: 'active',
    maxParticipants: 5,
    budgetAmount: '1000.00',
    budgetCurrency: 'USD',
    createdBy: 'maker-1',
    approvedBy: null,
    approvedAt: null,
    definitionPinnedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as TenantCampaign;
}

/** A `campaign_merchants` row shaped exactly as `toMerchantCampaignDetailDto` expects to read it. */
export function campaignMerchantRow(overrides: Partial<CampaignMerchant> = {}): CampaignMerchant {
  return {
    id: 1,
    tenantId: 10,
    campaignId: 1,
    merchantId: 100,
    status: 'active',
    createdAt: new Date('2026-01-05T00:00:00.000Z'),
    updatedAt: new Date('2026-01-05T00:00:00.000Z'),
    ...overrides,
  } as unknown as CampaignMerchant;
}

/** A `merchant_activities` row shaped exactly as `listMyActivities` expects to read it. */
export function merchantActivityRow(overrides: Partial<MerchantActivity> = {}): MerchantActivity {
  return {
    id: 300,
    tenantId: 10,
    merchantId: 100,
    activityId: 50,
    storeId: null,
    commissionRate: '2.50',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as MerchantActivity;
}

/** An `activities` row shaped exactly as `listMyActivities` expects to read it. */
export function activityRow(overrides: Partial<Activity> = {}): Activity {
  return {
    id: 50,
    tenantId: 10,
    typeId: 1,
    activityCode: 'PURCHASE',
    name: 'In-store purchase',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as Activity;
}
