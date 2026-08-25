/**
 * T-013 — property-based scope resolution (architect review AR-17, 2026-08-14).
 *
 * The task file is explicit about why the fixed cases are not enough here:
 *
 * > The fixed cases above are necessary but not sufficient for this specific module … the
 * > interesting scope-resolution bugs tend to live in input shapes nobody enumerated by hand.
 * > Add a `fast-check` suite that generates random `(role, scopeTriple, targetRow)` combinations
 * > across all six roles and asserts the result matches a small, independently-written naive
 * > reference resolver … any disagreement is a bug in one of the two, almost always the
 * > production one.
 *
 * ### How the two sides are kept genuinely independent
 *
 * **Production side.** `buildScopeWhere(model, scope)` produces a Sequelize clause. To turn that
 * into a row set without a database, {@link matches} interprets the clause against the fixture
 * world below — an evaluator that understands `{attr: value}`, `Op.and`, `Op.or`,
 * `{attr: {[Op.in]: literal(sql)}}` and the `1 = 0` literal, and **throws on anything it does
 * not recognise**. That last property is what stops the evaluator from quietly agreeing with a
 * clause it failed to understand.
 *
 * **Reference side.** {@link naiveVisible} is a hand-written predicate per (model, role),
 * transcribed from 00-ARCHITECTURE.md §5.1/§5.2, 01-DATABASE.md §4/§5.1 and 03-API-CONTRACT.md
 * §13/§14 — not from `scope-strategy.ts`. It is deliberately naive: nested loops over the
 * fixture arrays, no shared helpers with production code, no imports from `@/common/scope` at
 * all. If it and the production clause ever disagree, one of the two is wrong about the design
 * documents, which is exactly the disagreement worth surfacing.
 *
 * The subquery SQL is the one thing both sides touch, and `matches` resolves it by matching the
 * *fragment constants* — an unknown fragment throws rather than returning `false`, so changing a
 * subquery in `scope-strategy.ts` without teaching the evaluator fails this suite loudly instead
 * of silently narrowing what it checks.
 *
 * The harness is T-016's seeded generator rather than `fast-check` itself; see
 * `support/property-testing.ts`.
 */
import { Op, type Model, type ModelStatic } from 'sequelize';
import {
  ApprovalPolicy,
  CampaignMerchant,
  Country,
  Merchant,
  RuleMaster,
  SystemMessage,
  Tenant,
  TenantCampaign,
  UserNotification,
  VersionBlast,
} from '@/database/models';
import { PortalUser } from '@/database/portal-models';
import { buildTestSequelize } from '@/database/models/build-test-sequelize';
import { buildScopeWhere, type RequestScope } from '@/common/scope';
import type { PortalRole } from '@/database/portal-models';
import fc from './support/property-testing';

buildTestSequelize();

// --- the fixture world ------------------------------------------------------------------------
// Small enough to reason about by hand, wide enough that every clause shape in the map has
// something to discriminate: two countries, three tenants across them, three merchants, four
// campaigns with partial merchant participation, and two rules of which only one is assigned.

interface Row {
  readonly id: number;
  readonly [column: string]: number | string | null;
}

const COUNTRIES: Row[] = [{ id: 1 }, { id: 2 }];

const TENANTS: Row[] = [
  { id: 10, countryId: 1 },
  { id: 11, countryId: 1 },
  { id: 20, countryId: 2 },
];

const MERCHANTS: Row[] = [
  { id: 100, tenantId: 10 },
  { id: 101, tenantId: 11 },
  { id: 200, tenantId: 20 },
];

const CAMPAIGNS: Row[] = [
  { id: 1000, tenantId: 10 },
  { id: 1001, tenantId: 10 },
  { id: 1100, tenantId: 11 },
  { id: 2000, tenantId: 20 },
];

/** `campaign_merchants`, including one `inactive` row that participation must not count. */
const CAMPAIGN_MERCHANTS: Row[] = [
  { id: 1, tenantId: 10, campaignId: 1000, merchantId: 100, status: 'active' },
  { id: 2, tenantId: 10, campaignId: 1001, merchantId: 100, status: 'inactive' },
  { id: 3, tenantId: 11, campaignId: 1100, merchantId: 101, status: 'active' },
  { id: 4, tenantId: 20, campaignId: 2000, merchantId: 200, status: 'active' },
];

const RULES: Row[] = [
  { id: 500, tenantId: null },
  { id: 501, tenantId: null },
];

/** Only rule 500 is assigned, and only to country 1. */
const RULE_ASSIGNMENTS: Row[] = [{ id: 1, ruleId: 500, countryId: 1 }];

const APPROVAL_POLICIES: Row[] = [
  { id: 1, tenantId: null },
  { id: 2, tenantId: 10 },
  { id: 3, tenantId: 20 },
];

const NOTIFICATIONS: Row[] = [
  { id: 1, tenantId: 10, userId: 900 },
  { id: 2, tenantId: 10, userId: 901 },
  { id: 3, tenantId: 20, userId: 902 },
];

const PORTAL_USERS: Row[] = [
  { id: 900, countryId: 1, tenantId: 10, merchantId: null },
  { id: 901, countryId: 1, tenantId: 10, merchantId: 100 },
  { id: 902, countryId: 2, tenantId: 20, merchantId: 200 },
  { id: 903, countryId: 1, tenantId: 11, merchantId: null },
];

const BLASTS: Row[] = [{ id: 1 }, { id: 2 }];
const MESSAGES: Row[] = [{ id: 1 }, { id: 2 }];

const WORLD = new Map<ModelStatic<Model>, Row[]>([
  [Country, COUNTRIES],
  [Tenant, TENANTS],
  [Merchant, MERCHANTS],
  [TenantCampaign, CAMPAIGNS],
  [CampaignMerchant, CAMPAIGN_MERCHANTS],
  [RuleMaster, RULES],
  [ApprovalPolicy, APPROVAL_POLICIES],
  [UserNotification, NOTIFICATIONS],
  [PortalUser, PORTAL_USERS],
  [VersionBlast, BLASTS],
  [SystemMessage, MESSAGES],
]);

const MODELS = [...WORLD.keys()];

// --- the evaluator (production side) ------------------------------------------------------------

/**
 * The exact SQL each known subquery must be, normalised (whitespace collapsed, the generated
 * `:rsScopeN` placeholder renamed to `:v`).
 *
 * **Exact match, not `includes`.** The first draft of this evaluator matched on
 * `sql.includes('campaign_merchants')` and then applied its own hand-written
 * `status === 'active'` filter — which meant that deleting `AND cm.status = 'active'` from the
 * production fragment changed the real query and changed nothing here, and the whole suite went
 * on passing. That is precisely the failure mode a property suite is least able to notice about
 * itself, and it was caught only by deliberately mutating the production constant and observing
 * that nothing went red.
 *
 * Matching the full text means any edit to a fragment — including one that silently widens it —
 * lands in the `unknown subquery` branch and fails loudly until somebody re-derives the
 * corresponding semantics below by hand. The semantics remain independently written; only the
 * *identification* of which fragment is which is by text.
 */
const KNOWN_SUBQUERIES: readonly { sql: string; rows: (value: number) => number[] }[] = [
  {
    sql: 'SELECT t.id FROM reward_config.tenants t WHERE t.country_id = :v',
    rows: (countryId) => TENANTS.filter((t) => t.countryId === countryId).map((t) => t.id),
  },
  {
    sql:
      'SELECT cm.campaign_id FROM reward_config.campaign_merchants cm ' +
      "WHERE cm.merchant_id = :v AND cm.status = 'active'",
    rows: (merchantId) =>
      CAMPAIGN_MERCHANTS.filter((cm) => cm.merchantId === merchantId && cm.status === 'active').map(
        (cm) => cm.campaignId as number,
      ),
  },
  {
    sql: 'SELECT rca.rule_id FROM reward_config.rule_country_assignments rca WHERE rca.country_id = :v',
    rows: (countryId) =>
      RULE_ASSIGNMENTS.filter((a) => a.countryId === countryId).map((a) => a.ruleId as number),
  },
];

function normaliseSql(sql: string): string {
  return sql
    .replace(/:rsScope\d+/g, ':v')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolves one of {@link KNOWN_SUBQUERIES}. Unknown or altered SQL **throws** — see above.
 */
function resolveSubquery(sql: string, value: number): number[] {
  const normalised = normaliseSql(sql);
  const known = KNOWN_SUBQUERIES.find((candidate) => candidate.sql === normalised);

  if (known === undefined) {
    throw new Error(
      'The property evaluator does not understand this subquery — it has been changed or added ' +
        `since the evaluator was written, and its semantics must be re-derived by hand:\n${normalised}`,
    );
  }

  return known.rows(value);
}

/** Evaluates a Sequelize clause against one fixture row. */
function matches(
  clause: unknown,
  row: Row,
  replacements: Readonly<Record<string, number>>,
): boolean {
  if (clause === null || clause === undefined) return true;

  // `literal('1 = 0')` — the deny clause.
  if (typeof clause === 'object' && 'val' in (clause as Record<string, unknown>)) {
    const val = (clause as { val: string }).val;
    if (val === '1 = 0') return false;
    throw new Error(`The property evaluator does not understand this literal: ${val}`);
  }

  const record = clause as Record<string | symbol, unknown>;

  if (Array.isArray(record[Op.and])) {
    return (record[Op.and] as unknown[]).every((part) => matches(part, row, replacements));
  }
  if (Array.isArray(record[Op.or])) {
    return (record[Op.or] as unknown[]).some((part) => matches(part, row, replacements));
  }

  const keys = Object.keys(record);
  if (keys.length === 0) {
    throw new Error('The property evaluator received an empty clause object');
  }

  return keys.every((attribute) => {
    const expected = record[attribute];

    if (expected === null || typeof expected === 'number') {
      return row[attribute] === expected;
    }

    const inClause = (expected as Record<symbol, unknown>)[Op.in];
    if (inClause !== undefined) {
      const raw = (inClause as { val: string }).val;
      const name = /:(rsScope\d+)/.exec(raw)?.[1];
      if (name === undefined) throw new Error(`No bound placeholder in subquery: ${raw}`);

      const value = replacements[name];
      if (value === undefined) throw new Error(`Unbound placeholder ${name}`);

      // Strip the wrapping parentheses the clause builder adds.
      const sql = raw.replace(/^\(/, '').replace(/\)$/, '');
      return resolveSubquery(sql, value).includes(row[attribute] as number);
    }

    throw new Error(`The property evaluator does not understand: ${JSON.stringify(expected)}`);
  });
}

/** The row ids the production clause admits. */
function productionVisible(model: ModelStatic<Model>, scope: RequestScope): number[] {
  const { where, replacements } = buildScopeWhere(model, scope);
  return (WORLD.get(model) ?? [])
    .filter((row) => matches(where, row, replacements))
    .map((row) => row.id);
}

// --- the reference resolver (independently written) ---------------------------------------------

/**
 * A second, deliberately non-optimised implementation, transcribed from the design documents.
 *
 * Written as a flat switch with nested loops on purpose: it must be obviously correct by reading,
 * and it must share nothing with the production path. Do not refactor it to use a helper from
 * `scope-strategy.ts` — the moment it does, this suite tests one implementation twice.
 */
function naiveVisible(model: ModelStatic<Model>, scope: RequestScope): number[] {
  const rows = WORLD.get(model) ?? [];
  const { role, countryId, tenantId, merchantId, userId } = scope;

  // 00-ARCHITECTURE.md §5.1: super_admin is global.
  if (role === 'super_admin') return rows.map((row) => row.id);

  const isCountryAdmin = role === 'country_admin';
  const isMerchant = role === 'merchant';
  // tenant_admin / maker / checker all share the tenant scope shape.
  const isTenantScoped = role === 'tenant_admin' || role === 'maker' || role === 'checker';

  const keep = (predicate: (row: Row) => boolean): number[] =>
    rows.filter(predicate).map((row) => row.id);

  switch (model) {
    // Global, Super-Admin-owned configuration — every role reads it (01-DATABASE.md §3).
    case SystemMessage:
      return rows.map((row) => row.id);

    // A non-super-admin sees exactly its own country.
    case Country:
      return keep((row) => row.id === countryId);

    // 00-ARCHITECTURE.md §5: a country_admin owns the tenants in its country; everyone below
    // sees only the tenant they belong to.
    case Tenant:
      if (isCountryAdmin) return keep((row) => row.countryId === countryId);
      return keep((row) => row.id === tenantId);

    case Merchant:
      if (isCountryAdmin) {
        return keep((row) =>
          TENANTS.some((t) => t.id === row.tenantId && t.countryId === countryId),
        );
      }
      if (isMerchant) return keep((row) => row.tenantId === tenantId && row.id === merchantId);
      return keep((row) => row.tenantId === tenantId);

    case TenantCampaign:
      if (isCountryAdmin) {
        return keep((row) =>
          TENANTS.some((t) => t.id === row.tenantId && t.countryId === countryId),
        );
      }
      if (isMerchant) {
        // 03-API-CONTRACT.md §13: "only campaigns where the caller's merchant_id appears in
        // campaign_merchants".
        return keep(
          (row) =>
            row.tenantId === tenantId &&
            CAMPAIGN_MERCHANTS.some(
              (cm) =>
                cm.campaignId === row.id && cm.merchantId === merchantId && cm.status === 'active',
            ),
        );
      }
      return keep((row) => row.tenantId === tenantId);

    case CampaignMerchant:
      if (isCountryAdmin) {
        return keep((row) =>
          TENANTS.some((t) => t.id === row.tenantId && t.countryId === countryId),
        );
      }
      if (isMerchant)
        return keep((row) => row.tenantId === tenantId && row.merchantId === merchantId);
      return keep((row) => row.tenantId === tenantId);

    // 01-DATABASE.md §4: a global rule is visible only where it has been assigned. A merchant
    // has no `rule` permission at all.
    case RuleMaster:
      if (isMerchant) return [];
      return keep((row) =>
        RULE_ASSIGNMENTS.some((a) => a.ruleId === row.id && a.countryId === countryId),
      );

    // A NULL tenant_id is a global default policy; merchants do not see policies.
    case ApprovalPolicy:
      if (isMerchant) return [];
      if (isCountryAdmin) {
        return keep(
          (row) =>
            row.tenantId === null ||
            TENANTS.some((t) => t.id === row.tenantId && t.countryId === countryId),
        );
      }
      return keep((row) => row.tenantId === null || row.tenantId === tenantId);

    // 03-API-CONTRACT.md §14: "own only".
    case UserNotification:
      return keep((row) => row.userId === userId);

    case PortalUser:
      if (isCountryAdmin) return keep((row) => row.countryId === countryId);
      if (isMerchant)
        return keep((row) => row.tenantId === tenantId && row.merchantId === merchantId);
      return keep((row) => row.tenantId === tenantId);

    // T-041: blasts are authored and read by Super Admin only.
    case VersionBlast:
      return [];

    default:
      throw new Error(`The reference resolver has no case for ${model.name}`);
  }
  // `isTenantScoped` is read by the branches above through their fall-through defaults; naming it
  // keeps the role taxonomy visible at the top of the function.
  void isTenantScoped;
}

// --- generators ---------------------------------------------------------------------------------

const ROLES: readonly PortalRole[] = [
  'super_admin',
  'country_admin',
  'tenant_admin',
  'maker',
  'checker',
  'merchant',
];

/**
 * Builds a scope triple that satisfies `ck_portal_users_scope` (01-DATABASE.md §2.1) for the
 * role — the only shapes the database can actually hold, and therefore the only ones a valid
 * token can carry.
 */
function scopeFor(
  role: PortalRole,
  countryId: number,
  tenantId: number,
  merchantId: number,
): RequestScope {
  const userId = PORTAL_USERS[merchantId % PORTAL_USERS.length].id;

  switch (role) {
    case 'super_admin':
      return { userId, role, countryId: null, tenantId: null, merchantId: null };
    case 'country_admin':
      return { userId, role, countryId, tenantId: null, merchantId: null };
    case 'merchant':
      return { userId, role, countryId, tenantId, merchantId };
    default:
      return { userId, role, countryId, tenantId, merchantId: null };
  }
}

describe('scope resolution — property-based (AR-17)', () => {
  it('agrees with the naive reference resolver for every role, scope and model', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ROLES),
        // Ids drawn from the fixture world, plus values that exist in no row at all — the
        // "scoped to something that does not exist" case, which must yield nothing rather than
        // everything.
        fc.constantFrom(1, 2, 3, 99),
        fc.constantFrom(10, 11, 20, 99),
        fc.constantFrom(100, 101, 200, 999),
        (role, countryId, tenantId, merchantId) => {
          const scope = scopeFor(role, countryId, tenantId, merchantId);

          for (const model of MODELS) {
            const produced = productionVisible(model, scope).sort((a, b) => a - b);
            const expected = naiveVisible(model, scope).sort((a, b) => a - b);

            if (JSON.stringify(produced) !== JSON.stringify(expected)) {
              throw new Error(
                `${model.name} disagreed for ${role} ` +
                  `(country=${scope.countryId}, tenant=${scope.tenantId}, merchant=${scope.merchantId}): ` +
                  `production=[${produced.join(',')}] reference=[${expected.join(',')}]`,
              );
            }
          }
        },
      ),
      { numRuns: 2_000, seed: 20260818 },
    );
  });

  it('never admits a row belonging to another tenant, for any generated scope', () => {
    // A weaker but differently-shaped invariant: stated over the *data*, not over a second
    // implementation, so a shared misunderstanding between the two resolvers would still be
    // caught here.
    fc.assert(
      fc.property(
        fc.constantFrom('tenant_admin' as const, 'maker' as const, 'checker' as const),
        fc.constantFrom(10, 11, 20),
        (role, tenantId) => {
          const countryId = TENANTS.find((t) => t.id === tenantId)?.countryId as number;
          const scope = scopeFor(role, countryId, tenantId, 100);

          for (const id of productionVisible(TenantCampaign, scope)) {
            const row = CAMPAIGNS.find((c) => c.id === id) as Row;
            if (row.tenantId !== tenantId) {
              throw new Error(
                `campaign ${id} (tenant ${String(row.tenantId)}) leaked to tenant ${tenantId}`,
              );
            }
          }
        },
      ),
      { numRuns: 500, seed: 20260818 },
    );
  });

  it('never admits a campaign a merchant does not actively participate in', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(100, 101, 200),
        fc.constantFrom(10, 11, 20),
        (merchantId, tenantId) => {
          const countryId = TENANTS.find((t) => t.id === tenantId)?.countryId as number;
          const scope = scopeFor('merchant', countryId, tenantId, merchantId);

          for (const id of productionVisible(TenantCampaign, scope)) {
            const participates = CAMPAIGN_MERCHANTS.some(
              (cm) =>
                cm.campaignId === id && cm.merchantId === merchantId && cm.status === 'active',
            );
            if (!participates) {
              throw new Error(`merchant ${merchantId} saw campaign ${id} without participating`);
            }
          }
        },
      ),
      { numRuns: 500, seed: 20260818 },
    );
  });

  it('never admits an unassigned global rule to any non-super-admin', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'country_admin' as const,
          'tenant_admin' as const,
          'maker' as const,
          'checker' as const,
          'merchant' as const,
        ),
        fc.constantFrom(1, 2, 99),
        (role, countryId) => {
          const scope = scopeFor(role, countryId, 10, 100);

          for (const id of productionVisible(RuleMaster, scope)) {
            const assigned = RULE_ASSIGNMENTS.some(
              (a) => a.ruleId === id && a.countryId === countryId,
            );
            if (!assigned)
              throw new Error(`${role} in country ${countryId} saw unassigned rule ${id}`);
          }
        },
      ),
      { numRuns: 500, seed: 20260818 },
    );
  });

  it('the evaluator itself refuses clauses it does not understand', () => {
    // Guards the guard: if this ever stops throwing, the suite above could pass while silently
    // checking nothing.
    expect(() => resolveSubquery('SELECT id FROM something_new', 1)).toThrow(/does not understand/);
    // The specific regression that motivated the exact-match rule: a fragment that is *almost*
    // one of the known ones must not be silently treated as it.
    expect(() =>
      resolveSubquery(
        'SELECT cm.campaign_id FROM reward_config.campaign_merchants cm WHERE cm.merchant_id = :rsScope0',
        100,
      ),
    ).toThrow(/does not understand/);
    expect(() => matches({ id: { [Op.gt]: 1 } }, { id: 1 }, {})).toThrow(/does not understand/);
    expect(() => matches({ val: 'TRUE' }, { id: 1 }, {})).toThrow(/does not understand/);
  });
});
