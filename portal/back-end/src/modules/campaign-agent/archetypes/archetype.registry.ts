/**
 * T-048 — the archetype registry (ported from
 * `agents/create-campaign-v2/src/archetypes/archetype.registry.ts`).
 *
 * A closed map, not a plugin point. Two archetypes exist; a third is a code change and a review,
 * which is the right cost for "a new kind of campaign the agent can propose". Registering
 * archetypes dynamically would put a structural decision behind a data row, and 00-ARCHITECTURE.md
 * §5.4 already records why this project keeps that kind of decision in code and in the type
 * checker.
 */
import { Injectable } from '@nestjs/common';
import type { AgentArchetype } from '@reward-portal/shared';
import type { CampaignArchetype } from './archetype.interface';
import { InstantRewardArchetype } from './instant-reward.archetype';
import { DeferredRewardArchetype } from './deferred-reward.archetype';

@Injectable()
export class ArchetypeRegistry {
  private readonly byKey: ReadonlyMap<AgentArchetype, CampaignArchetype> = new Map<
    AgentArchetype,
    CampaignArchetype
  >([
    ['instant_reward', new InstantRewardArchetype()],
    ['deferred_reward', new DeferredRewardArchetype()],
  ]);

  /** Every archetype, for the opening message's "which of these do you mean?". */
  all(): readonly CampaignArchetype[] {
    return [...this.byKey.values()];
  }

  /**
   * The archetype for `key`.
   *
   * Throws rather than returning `undefined`: `key` has already been through
   * `agentArchetypeSchema`, so an unknown value here means the enum and this map have drifted —
   * a programming error, and one that would otherwise show up as a campaign silently skipping its
   * shape checks.
   */
  get(key: AgentArchetype): CampaignArchetype {
    const archetype = this.byKey.get(key);
    if (archetype === undefined) {
      throw new Error(`No archetype registered for "${key}" — the enum and the registry disagree.`);
    }
    return archetype;
  }

  /**
   * §4 step 1 — *"I want a weekend cashback campaign for our electronics merchants"* → archetype
   * detected: `instant_reward`.
   *
   * Deterministic keyword matching in Zone 2, never the model (see
   * {@link CampaignArchetype.intentKeywords} for why). Returns `null` when nothing matches or when
   * two archetypes match equally — the agent then *asks*, which is the honest outcome and is
   * cheaper than guessing wrong and having the maker discover it at the review panel.
   */
  detect(text: string): AgentArchetype | null {
    const haystack = text.toLowerCase();
    const scored = this.all().map((archetype) => ({
      key: archetype.key,
      score: archetype.intentKeywords.filter((word) => haystack.includes(word)).length,
    }));

    const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
    if (best.score === 0) return null;
    const tied = scored.filter((entry) => entry.score === best.score).length > 1;
    return tied ? null : best.key;
  }
}
