/**
 * T-048 — the archetype registry and its two archetypes.
 *
 * The detector is Zone 2 code precisely so it can be tested like this: given a sentence, the same
 * archetype comes out every time, and the model is not consulted.
 */
import { ArchetypeRegistry } from '@/modules/campaign-agent/archetypes/archetype.registry';
import { emptySlots, type AgentSlots } from '@/modules/campaign-agent/agent.state';

const registry = new ArchetypeRegistry();

function slots(overrides: Partial<AgentSlots> = {}): AgentSlots {
  return { ...emptySlots(), ...overrides };
}

describe('registry', () => {
  it('holds exactly the two archetypes ported from create-campaign-v2', () => {
    expect(registry.all().map((archetype) => archetype.key)).toEqual([
      'instant_reward',
      'deferred_reward',
    ]);
  });

  it('returns an archetype by key', () => {
    expect(registry.get('instant_reward').label).toBe('Instant reward');
    expect(registry.get('deferred_reward').label).toBe('Deferred reward');
  });

  it('throws for a key the enum and the map disagree about', () => {
    expect(() => registry.get('nonexistent' as never)).toThrow(/disagree/);
  });
});

describe('detect — §4 step 1', () => {
  it('detects an instant reward from the design doc’s own example sentence', () => {
    expect(
      registry.detect('I want a weekend cashback campaign for our electronics merchants'),
    ).toBe('instant_reward');
  });

  it('detects a deferred reward from a milestone phrasing', () => {
    expect(registry.detect('collect 5 stamps and then get a reward')).toBe('deferred_reward');
  });

  it('is case-insensitive', () => {
    expect(registry.detect('INSTANT CASHBACK PLEASE')).toBe('instant_reward');
  });

  it('returns null rather than guessing when nothing matches', () => {
    expect(registry.detect('hello')).toBeNull();
  });

  it('returns null rather than guessing when two archetypes match equally', () => {
    // "instant" (1) vs "collect" (1) — a tie. Asking is cheaper than being wrong at the review
    // panel.
    expect(registry.detect('instant collect')).toBeNull();
  });
});

describe('instant_reward shape rules', () => {
  const archetype = registry.get('instant_reward');

  it('accepts a single activity', () => {
    expect(archetype.validateShape(slots({ activities: ['a_1'] }))).toEqual([]);
  });

  it('refuses more than one activity — that is a deferred reward wearing the wrong label', () => {
    const violations = archetype.validateShape(slots({ activities: ['a_1', 'a_2'] }));
    expect(violations.map((violation) => violation.code)).toContain(
      'INSTANT_REWARD_SINGLE_ACTIVITY',
    );
  });

  it('refuses an n_of threshold, which has nothing to count over one activity', () => {
    const violations = archetype.validateShape(
      slots({ activities: ['a_1'], completionLogic: 'n_of', completionThreshold: 1 }),
    );
    expect(violations.map((violation) => violation.code)).toContain('INSTANT_REWARD_NO_THRESHOLD');
  });

  it('defaults to "all" completion logic', () => {
    expect(archetype.defaultCompletionLogic).toBe('all');
  });
});

describe('deferred_reward shape rules', () => {
  const archetype = registry.get('deferred_reward');

  it('accepts a multi-activity journey with "all"', () => {
    expect(
      archetype.validateShape(slots({ activities: ['a_1', 'a_2'], completionLogic: 'all' })),
    ).toEqual([]);
  });

  it('requires a threshold for n_of', () => {
    const violations = archetype.validateShape(
      slots({ activities: ['a_1', 'a_2'], completionLogic: 'n_of', completionThreshold: null }),
    );
    expect(violations.map((violation) => violation.code)).toEqual([
      'DEFERRED_REWARD_THRESHOLD_REQUIRED',
    ]);
  });

  it('refuses a threshold above the activity count — a tracker nobody could ever finish', () => {
    // Mirrors T-037's own `UnachievableThresholdError`, caught during the conversation rather than
    // at the write.
    const violations = archetype.validateShape(
      slots({ activities: ['a_1', 'a_2'], completionLogic: 'n_of', completionThreshold: 3 }),
    );
    expect(violations.map((violation) => violation.code)).toEqual([
      'DEFERRED_REWARD_THRESHOLD_UNACHIEVABLE',
    ]);
    expect(violations[0].message).toContain('2');
  });

  it('accepts a threshold equal to the activity count', () => {
    expect(
      archetype.validateShape(
        slots({ activities: ['a_1', 'a_2'], completionLogic: 'n_of', completionThreshold: 2 }),
      ),
    ).toEqual([]);
  });
});
