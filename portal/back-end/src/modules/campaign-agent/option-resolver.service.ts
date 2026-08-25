/**
 * T-048 — the two gates that make prompt injection uninteresting (10-AI-CAMPAIGN-AGENT.md §3.1).
 *
 * > *"The LLM may then only reference `optionId` values it was handed in this turn. Zone 2
 * > re-resolves every `optionId` against the maker's scope before it is used. A hallucinated
 * > `optionId` fails resolution and the turn is rejected."*
 *
 * Two independent checks, in this order, and neither is sufficient alone:
 *
 *  1. **Was it offered?** ({@link assertOffered}) An id the tools never returned was invented — by
 *     the model, or by text the model read. `merchant 999` from an injected rule description
 *     (TC-10) fails here, before any database call, because nothing ever minted a token for it.
 *  2. **Does it still resolve, for *this* maker, *now*?** ({@link resolveMerchants} and friends)
 *     Every resolution goes back through `ScopedRepository`, so a merchant from another tenant is
 *     unreachable (TC-8) and a rule no longer assigned to the maker's country is unreachable
 *     (TC-9) — including one that *was* legitimately offered an hour ago and has since been
 *     unassigned. Authorisation is never cached in the session.
 *
 * ### Why the tokens are opaque and prefixed rather than raw ids
 *
 * A raw id in the model's context is an invitation to arithmetic: `m_7` exists, so `m_8` probably
 * does. That inference is *correct* and it is why the offered-set check matters more than the
 * token format. The prefix earns its keep differently — it makes a category confusion
 * (`rewardOptionId` where a rule was expected) a parse failure rather than a lookup that happens
 * to find the wrong kind of row.
 *
 * ### One deviation from §3.1, stated plainly
 *
 * §3.1 says *"handed to it in this turn"*. This implementation scopes the offered set to the
 * **session**, not the turn, because a conversation that forgets its merchant options the moment
 * it asks about activities cannot reach step 5 — the maker would have to re-pick everything on
 * every turn. The security property is unchanged: the set still contains only tokens Zone 2 minted
 * from rows this maker could reach, and gate 2 re-checks every one of them against live scope at
 * the moment of use. What widens is convenience; what does not widen is what the model can name.
 * Recorded here and in the completion report rather than quietly adopted.
 */
import { Injectable } from '@nestjs/common';
import { Op } from 'sequelize';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { Activity, Merchant, RuleMaster, RewardPolicy } from '@/database/models';
import { OPTION_PREFIX } from './agent.constants';
import { UnresolvableOptionError } from './agent.errors';

/** The offered set, as persisted in `agent_sessions.offered_options`. */
export interface OfferedOptions {
  readonly merchants: readonly string[];
  readonly activities: readonly string[];
  readonly rules: readonly string[];
  readonly rewards: readonly string[];
}

export type OptionKind = keyof OfferedOptions;

export function emptyOffered(): OfferedOptions {
  return { merchants: [], activities: [], rules: [], rewards: [] };
}

const PREFIX_OF: Readonly<Record<OptionKind, string>> = Object.freeze({
  merchants: OPTION_PREFIX.MERCHANT,
  activities: OPTION_PREFIX.ACTIVITY,
  rules: OPTION_PREFIX.RULE,
  rewards: OPTION_PREFIX.REWARD,
});

/** Mints the token for a row of `kind`. The only place a token is created. */
export function optionIdFor(kind: OptionKind, id: number): string {
  return `${PREFIX_OF[kind]}_${id}`;
}

/**
 * The numeric id inside a token, or `null` if it is not a token of `kind` at all.
 *
 * Strict by construction: the prefix must match exactly and the remainder must be a positive
 * integer with no leading zeros, sign, decimal point or whitespace. `m_007`, `m_-1`, `m_1e3` and
 * `m_1; DROP` all return `null` rather than a number that later becomes a query parameter.
 */
export function parseOptionId(kind: OptionKind, optionId: string): number | null {
  const prefix = `${PREFIX_OF[kind]}_`;
  if (!optionId.startsWith(prefix)) return null;
  const rest = optionId.slice(prefix.length);
  if (!/^[1-9]\d{0,9}$/.test(rest)) return null;
  return Number(rest);
}

/** Adds `ids` to the offered set for `kind`, de-duplicated and order-stable. */
export function recordOffered(
  offered: OfferedOptions,
  kind: OptionKind,
  optionIds: readonly string[],
): OfferedOptions {
  return { ...offered, [kind]: [...new Set([...offered[kind], ...optionIds])] };
}

@Injectable()
export class OptionResolverService {
  constructor(private readonly scoped: ScopedRepository) {}

  /**
   * Gate 1 — every token must be one the tools actually handed out in this session.
   *
   * Throws on the first failure rather than collecting them: the caller's turn is rejected either
   * way, and enumerating *which* of several invented ids was rejected is information an attacker
   * would use to bisect the offered set.
   */
  assertOffered(offered: OfferedOptions, kind: OptionKind, optionIds: readonly string[]): void {
    const allowed = new Set(offered[kind]);
    for (const optionId of optionIds) {
      if (!allowed.has(optionId)) throw new UnresolvableOptionError(kind);
    }
  }

  /**
   * Gate 2, merchants — TC-6 (*"`searchMerchants` as a tenant-A maker → only tenant A
   * merchants"*) and TC-8 (*"LLM returns another tenant's merchant id → rejected"*).
   *
   * The tenancy clause is `ScopedRepository`'s, not one written here: `Merchant`'s strategy already
   * restricts a maker to its own tenant, so a cross-tenant id simply does not come back and the
   * count check below turns that into a rejection. Writing an explicit `tenantId` filter would be
   * a second, weaker copy of a rule that already exists — and one that could drift.
   */
  async resolveMerchants(
    offered: OfferedOptions,
    optionIds: readonly string[],
  ): Promise<readonly { id: number; name: string }[]> {
    const ids = this.toIds(offered, 'merchants', optionIds);
    if (ids.length === 0) return [];

    const rows = await this.scoped.listAll(Merchant, {
      where: { id: { [Op.in]: ids } },
      order: [['name', 'ASC']],
    });
    this.assertAllResolved('merchants', ids, rows);
    return rows.map((row) => ({ id: row.id, name: row.name }));
  }

  /** Gate 2, activities. Membership of the campaign's merchants is checked separately, by
   * `journey.service.ts`, at the write — see `policy-engine.service.ts` for why this file does not
   * duplicate it. */
  async resolveActivities(
    offered: OfferedOptions,
    optionIds: readonly string[],
  ): Promise<readonly { id: number; name: string }[]> {
    const ids = this.toIds(offered, 'activities', optionIds);
    if (ids.length === 0) return [];

    const rows = await this.scoped.listAll(Activity, {
      where: { id: { [Op.in]: ids } },
      order: [['name', 'ASC']],
    });
    this.assertAllResolved('activities', ids, rows);
    return rows.map((row) => ({ id: row.id, name: row.name }));
  }

  /**
   * Gate 2, rules — TC-9 (*"LLM returns a rule version not assigned to the country → rejected"*).
   *
   * `RuleMaster`'s scope strategy is the country-assignment subquery
   * (`ruleId IN (SELECT rule_id FROM rule_country_assignments WHERE country_id = …)`), so an
   * unassigned rule is unreachable here for exactly the same reason an unassigned rule is
   * unreachable in the wizard's own picker. The *version* pin is then resolved by
   * `bindings.service.ts` at the bind, from the same assignment — the agent never chooses a
   * version number.
   */
  async resolveRules(
    offered: OfferedOptions,
    optionIds: readonly string[],
  ): Promise<readonly { id: number; ruleCode: string; name: string }[]> {
    const ids = this.toIds(offered, 'rules', optionIds);
    if (ids.length === 0) return [];

    const rows = await this.scoped.listAll(RuleMaster, {
      where: { id: { [Op.in]: ids } },
      order: [['name', 'ASC']],
    });
    this.assertAllResolved('rules', ids, rows);
    return rows.map((row) => ({ id: row.id, ruleCode: row.ruleCode, name: row.name }));
  }

  /** Gate 2, reward policies. `RewardPolicy`'s strategy is the country-assignment mirror of the
   * rule side. */
  async resolveRewardPolicies(
    offered: OfferedOptions,
    optionIds: readonly string[],
  ): Promise<readonly { id: number; name: string }[]> {
    const ids = this.toIds(offered, 'rewards', optionIds);
    if (ids.length === 0) return [];

    const rows = await this.scoped.listAll(RewardPolicy, {
      where: { id: { [Op.in]: ids } },
      order: [['name', 'ASC']],
    });
    this.assertAllResolved('rewards', ids, rows);
    return rows.map((row) => ({ id: row.id, name: row.name }));
  }

  // --- private -------------------------------------------------------------------------------

  /** Gate 1 plus parsing. A token that fails either is indistinguishable in the response. */
  private toIds(
    offered: OfferedOptions,
    kind: OptionKind,
    optionIds: readonly string[],
  ): readonly number[] {
    this.assertOffered(offered, kind, optionIds);
    const ids: number[] = [];
    for (const optionId of optionIds) {
      const id = parseOptionId(kind, optionId);
      if (id === null) throw new UnresolvableOptionError(kind);
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /**
   * Every requested id must have come back.
   *
   * A count comparison rather than a per-id diff, for the same reason {@link assertOffered} throws
   * on the first failure: the caller learns that something did not resolve, never which thing —
   * which is what keeps "out of scope" and "does not exist" indistinguishable (02-SECURITY.md
   * §5.1).
   */
  private assertAllResolved(
    kind: OptionKind,
    requested: readonly number[],
    rows: readonly { id: number }[],
  ): void {
    if (rows.length !== requested.length) throw new UnresolvableOptionError(kind);
  }
}
