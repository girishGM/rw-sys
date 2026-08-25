/**
 * T-086 — the regression suite for `timing-budget.ts`.
 *
 * This is the file that makes the T-086 fix a tested claim rather than an asserted one, and it
 * is deliberately built the way AGENT-PROTOCOL §3 demands: it asserts the *observable property*
 * of the statistic (how often it cries leak when there is none, and whether it still catches one
 * when there is) rather than restating any constant inside it.
 *
 * Everything here is deterministic — a seeded PRNG stands in for the machine, so these tests
 * cannot themselves become the flaky tests they exist to eliminate. No clock is read.
 *
 * The load model is not arbitrary. It reproduces the shape a loaded box actually produces, which
 * is what broke the original assertions: a tight log-normal body (ordinary scheduling jitter)
 * plus occasional large multiplicative spikes (another suite's Argon2 or 1 MiB crypto loop
 * stealing the core). A symmetric ±10% model would make every estimator look fine and would
 * have proved nothing.
 */
import {
  describeTrials,
  interleavedHalves,
  legacyTimingVerdict,
  quantile,
  timingFloor,
  timingGap,
  timingVerdict,
  measureUntilClean,
  type TimingSamples,
} from './timing-budget';

/** mulberry32 — small, fast, and fully determined by its seed. */
const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

interface Load {
  readonly name: string;
  /** Probability that any single sample is hit by a contention spike. */
  readonly spikeRate: number;
  /** Width of the log-normal body: ordinary scheduling jitter. */
  readonly spread: number;
  /** Largest multiple a spike can inflate a sample by. */
  readonly spikeMax: number;
}

const LOADS: Load[] = [
  { name: 'mild', spikeRate: 0.05, spread: 0.4, spikeMax: 3 },
  { name: 'typical', spikeRate: 0.08, spread: 0.8, spikeMax: 6 },
  { name: 'harsh', spikeRate: 0.2, spread: 1.2, spikeMax: 10 },
  { name: 'brutal', spikeRate: 0.35, spread: 1.6, spikeMax: 20 },
];

const BASELINE_MS = 2;

/**
 * An awaited Argon2id hash against a ~2 ms baseline — the leak both live controls exist to catch.
 * Deliberately the *smallest* plausible one: Argon2 at the portal's parameters costs far more.
 */
const ARGON2_MS = 40;

/** One synthetic run of a measurement loop, interleaved exactly as the live controls interleave. */
const syntheticRun = (
  random: () => number,
  load: Load,
  extraOnKnown: number,
  samples = 30,
): TimingSamples => {
  const draw = (base: number): number => {
    const jitter = Math.exp((random() - 0.5) * load.spread);
    const spike = random() < load.spikeRate ? 1 + random() * load.spikeMax : 1;
    return base * jitter * spike;
  };

  const knownA: number[] = [];
  const knownB: number[] = [];
  const unknown: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    knownA.push(draw(BASELINE_MS + extraOnKnown));
    unknown.push(draw(BASELINE_MS));
    knownB.push(draw(BASELINE_MS + extraOnKnown));
  }
  return { knownA, knownB, unknown };
};

/** Drive `measureUntilClean` over synthetic trials, as the live controls drive it over real ones. */
const runControl = async (
  firstSeed: number,
  load: Load,
  extraOnKnown: number,
  attempts = 3,
): Promise<boolean> => {
  let seed = firstSeed;
  const outcome = await measureUntilClean(async () => {
    seed += 1;
    return syntheticRun(seeded(seed), load, extraOnKnown);
  }, attempts);
  return outcome.leaked;
};

describe('T-086 — the timing-budget statistic', () => {
  describe('building blocks', () => {
    it('quantile picks by nearest rank and does not mutate its input', () => {
      const values = [5, 1, 4, 2, 3];
      expect(quantile(values, 0)).toBe(1);
      expect(quantile(values, 0.5)).toBe(3);
      expect(quantile(values, 1)).toBe(5);
      expect(values).toEqual([5, 1, 4, 2, 3]);
    });

    it('timingFloor reads the fast end, so one huge spike cannot move it', () => {
      const clean = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
      const spiked = [...clean.slice(0, 9), 10_000];

      expect(timingFloor(spiked)).toBe(timingFloor(clean));
      // The mean, which `credential.service.spec.ts` used before T-086, moves by 100x on the
      // same data — which is exactly how a single GC pause used to fail that assertion.
      const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
      expect(mean(spiked) / mean(clean)).toBeGreaterThan(100);
    });

    it('interleavedHalves splits by parity, so both halves span the same window', () => {
      expect(interleavedHalves([1, 2, 3, 4, 5, 6])).toEqual([
        [1, 3, 5],
        [2, 4, 6],
      ]);
    });

    it('timingGap is symmetric, zero for identical sets, and relative to the slower one', () => {
      expect(timingGap([2, 2, 2], [2, 2, 2])).toBe(0);
      expect(timingGap([1, 1, 1], [2, 2, 2])).toBeCloseTo(0.5, 10);
      expect(timingGap([2, 2, 2], [1, 1, 1])).toBeCloseTo(0.5, 10);
    });

    it('describeTrials reports every trial, so a failure shows its working', () => {
      const summary = describeTrials([
        { signal: 0.5, noiseFloor: 0.2, threshold: 0.2, leaked: true },
        { signal: 0.05, noiseFloor: 0.2, threshold: 0.2, leaked: false },
      ]);
      expect(summary).toBe(
        '#1 signal 0.500 vs threshold 0.200; #2 signal 0.050 vs threshold 0.200',
      );
    });
  });

  /**
   * TC-3 proper. Each of these fails if `timingVerdict` is reverted to the single-draw median
   * form that shipped before T-086 — `legacyTimingVerdict`, measured side by side below on the
   * identical samples so the improvement is a number in the test output, not a claim in a comment.
   */
  describe('TC-3 — false positives under load', () => {
    const SEEDS = 400;

    it.each(LOADS)(
      'does not cry leak on same-path samples under $name load, where the old statistic did',
      async ({ name, ...load }) => {
        const asLoad = { name, ...load };
        let singleTrialFalsePositives = 0;
        let legacyFalsePositives = 0;

        for (let seed = 1; seed <= SEEDS; seed += 1) {
          const samples = syntheticRun(seeded(seed), asLoad, 0);
          if (timingVerdict(samples.knownA, samples.knownB, samples.unknown).leaked) {
            singleTrialFalsePositives += 1;
          }
          if (legacyTimingVerdict(samples.knownA, samples.knownB, samples.unknown).leaked) {
            legacyFalsePositives += 1;
          }
        }

        // Per trial, the new statistic is strictly and substantially better than the old.
        expect(singleTrialFalsePositives).toBeLessThan(legacyFalsePositives);

        // ...and with re-measurement on top, the control as a whole is essentially never wrong.
        let controlFalsePositives = 0;
        for (let seed = 1; seed <= SEEDS; seed += 1) {
          if (await runControl(seed * 1_000, asLoad, 0)) controlFalsePositives += 1;
        }
        expect(controlFalsePositives / SEEDS).toBeLessThanOrEqual(0.01);
      },
    );
  });

  /**
   * TC-4 — the half that stops this fix from being a way of making the test always pass. A
   * statistic that never cries leak is not robust, it is broken; these assert the power that was
   * traded nothing away for.
   */
  describe('TC-4 — a real leak is still caught, at every load level', () => {
    const SEEDS = 400;

    it.each(LOADS)(
      'flags an awaited Argon2 hash on the known path under $name load, every time',
      async ({ name, ...load }) => {
        const asLoad = { name, ...load };
        let missed = 0;

        for (let seed = 1; seed <= SEEDS; seed += 1) {
          if (!(await runControl(seed * 7_919, asLoad, ARGON2_MS))) missed += 1;
        }

        expect(missed).toBe(0);
      },
    );

    it('flags a leak far smaller than Argon2 — a 2x difference — under typical load', async () => {
      const typical = LOADS[1];
      let missed = 0;

      for (let seed = 1; seed <= 200; seed += 1) {
        if (!(await runControl(seed * 104_729, typical, BASELINE_MS))) missed += 1;
      }

      expect(missed).toBe(0);
    });
  });

  describe('measureUntilClean', () => {
    it('stops at the first clean trial, so a quiet machine pays for exactly one', async () => {
      let calls = 0;
      const outcome = await measureUntilClean(async () => {
        calls += 1;
        return syntheticRun(seeded(1), LOADS[0], 0);
      });

      expect(outcome.leaked).toBe(false);
      expect(calls).toBe(1);
      expect(outcome.trials).toHaveLength(1);
    });

    it('spends every attempt before reporting a leak, and reports all of them', async () => {
      let calls = 0;
      const outcome = await measureUntilClean(async () => {
        calls += 1;
        return syntheticRun(seeded(calls), LOADS[1], ARGON2_MS);
      });

      expect(outcome.leaked).toBe(true);
      expect(calls).toBe(3);
      expect(outcome.trials).toHaveLength(3);
      expect(describeTrials(outcome.trials)).toContain('#3');
    });

    it('honours a custom attempt count', async () => {
      let calls = 0;
      const outcome = await measureUntilClean(async () => {
        calls += 1;
        return syntheticRun(seeded(calls), LOADS[1], ARGON2_MS);
      }, 5);

      expect(outcome.leaked).toBe(true);
      expect(calls).toBe(5);
    });
  });
});
