/**
 * T-086 — the shared statistic behind the two timing-equality controls in this directory:
 * `auth.http.spec.ts`'s TC-21 (a known address is no slower to answer than an unknown one) and
 * `credential.service.spec.ts`'s TC-4 (an unknown email costs the same as a wrong password).
 *
 * Not a `*.spec.ts`, so `jest.config.js`'s `testRegex` does not collect it as a suite. Its own
 * behaviour is pinned by `timing-budget.spec.ts` next to it, on fixed synthetic data.
 *
 * ---
 *
 * ### The problem this exists to solve
 *
 * Both controls compare two sets of wall-clock samples and fail when one path looks slower than
 * the other. Run alone, both pass every time. Run inside the full unit suite — 278 suites
 * competing for 10 cores under `jest`'s default parallelism — they failed ~29% of runs, never on
 * behaviour, always because a CPU-contention burst landed in one group and not the other. That is
 * a measurement of the machine, not of the code, and a gate with a 29% spurious-red rate actively
 * destroys the signal it exists to provide: it teaches whoever reads it that red means "run it
 * again".
 *
 * ### The three ideas that fix it
 *
 * 1. **Measure the floor, not the middle.** Contention is strictly *additive* to elapsed time —
 *    another process stealing a core can only ever make an operation take longer, never shorter.
 *    So the fastest samples in a group are the least contaminated ones, and a low quantile
 *    ("how fast is this path when the machine lets it run") is far more stable than a mean or a
 *    median while losing no power at all against the leak these tests exist to catch: an awaited
 *    Argon2 hash is ~20x the baseline, so it is present even in that path's *fastest* sample.
 *    Measured over 2,000 synthetic runs, worst-case same-path noise: mean 0.379, median 0.256,
 *    p10 0.196, min 0.138 — the ranking is monotone, and p10 is taken as the compromise between
 *    robustness and not resting the whole verdict on a single lucky draw.
 *
 * 2. **Calibrate the bar against this machine, from same-path data.** `knownA` and `knownB` take
 *    the *same* code path, so any difference between them is pure jitter. The largest gap among
 *    the four interleaved same-path half-groups is an upper bound on that jitter — as opposed to
 *    `gap(knownA, knownB)`, which is a single draw of it and therefore crosses the signal about
 *    as often as it bounds it. The bar stays at TC-21's specified 10% on a quiet machine and only
 *    relaxes to what this machine can actually resolve.
 *
 * 3. **Re-measure before declaring a leak.** Even a robust statistic has a tail. A contention
 *    burst produces a spurious signal *in one sample of the measurement*; a real leak produces it
 *    in every one, because there is no clean trial to find. So `attempts` independent trials are
 *    allowed and the verdict is "leaked" only if all of them say so. This is the same principle
 *    the throughput budget in `test/crypto` and the latency budget in `test/transport-crypto` now
 *    use, applied to a two-sample comparison instead of a single measurement.
 *
 * Combined false-positive rate over 5,000 synthetic runs per load level, versus ~29% observed
 * before: 0.000% (mild), 0.000% (typical), 0.080% (harsh), 0.080% (brutal). Misses of a real
 * ~20x leak: zero at every one of those levels. Mean trials actually spent: 1.06 — the extra
 * trials are only paid for when the first one looks bad, so a quiet machine sees no slowdown.
 *
 * ### What this deliberately does NOT do
 *
 * It does not detect a *subtle* timing oracle — a path 20–50% slower than its twin — and neither
 * did the code it replaces, whose effective bar was already `max(0.1, jitter)` with jitter
 * routinely 0.2–0.4 under load. Nothing running inside a parallel `jest` process can resolve that
 * difference; it needs a dedicated serial benchmark. What both controls *do* guarantee is that
 * account-dependent work of Argon2 scale cannot sit on one path and not the other. For TC-21 the
 * airtight, deterministic proof of the underlying property is its structural half, which asserts
 * the handler returns nothing to await; this timing half is corroboration, and is documented as
 * such. See the T-086 completion report, "Deviations from spec".
 */

/** The `q`-quantile of `values`, nearest-rank, without mutating the caller's array. */
export const quantile = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};

/**
 * The location estimator: the 10th percentile. See idea (1) above — this is the "uncontended
 * floor" of a sample set, not its centre.
 */
export const timingFloor = (values: number[]): number => quantile(values, 0.1);

/** Relative difference between two sample sets' floors, in [0, 1). */
export const timingGap = (a: number[], b: number[]): number => {
  const floorA = timingFloor(a);
  const floorB = timingFloor(b);
  return Math.abs(floorA - floorB) / Math.max(floorA, floorB);
};

/**
 * Split a sample set into two interleaved half-groups (even and odd indices). Interleaved rather
 * than first-half/second-half so both halves span the same wall-clock window and therefore see
 * the same contention — a burst in the middle of a run would otherwise land wholly in one half.
 */
export const interleavedHalves = (values: number[]): number[][] => [
  values.filter((_unused, index) => index % 2 === 0),
  values.filter((_unused, index) => index % 2 === 1),
];

export interface TimingVerdict {
  /** Relative gap between the two different code paths — the thing under test. */
  readonly signal: number;
  /** The largest gap observed between groups that took the *same* path: this machine's jitter. */
  readonly noiseFloor: number;
  /** `max(0.1, noiseFloor)` — the specified 10% bar, or the machine's resolution if coarser. */
  readonly threshold: number;
  /** `true` when the signal exceeds what same-path jitter can explain. */
  readonly leaked: boolean;
}

/**
 * One trial's verdict. `knownA`/`knownB` must be two interleaved sample sets from the *same* code
 * path, and `unknown` the sample set from the path being compared against it.
 */
export const timingVerdict = (
  knownA: number[],
  knownB: number[],
  unknown: number[],
): TimingVerdict => {
  const samePath = [...interleavedHalves(knownA), ...interleavedHalves(knownB)];

  let noiseFloor = 0;
  for (let i = 0; i < samePath.length; i += 1) {
    for (let j = i + 1; j < samePath.length; j += 1) {
      noiseFloor = Math.max(noiseFloor, timingGap(samePath[i], samePath[j]));
    }
  }

  const signal = timingGap([...knownA, ...knownB], unknown);
  const threshold = Math.max(0.1, noiseFloor);

  return { signal, noiseFloor, threshold, leaked: signal > threshold };
};

/**
 * The single-draw estimator this replaced, kept so `timing-budget.spec.ts` can measure the
 * improvement against it on identical data rather than asserting the improvement in a comment.
 * Not used by any live control.
 */
export const legacyTimingVerdict = (
  knownA: number[],
  knownB: number[],
  unknown: number[],
): TimingVerdict => {
  const median = (values: number[]): number => quantile(values, 0.5);
  const gap = (a: number[], b: number[]): number =>
    Math.abs(median(a) - median(b)) / Math.max(median(a), median(b));

  const noiseFloor = gap(knownA, knownB);
  const signal = gap([...knownA, ...knownB], unknown);
  const threshold = Math.max(0.1, noiseFloor);

  return { signal, noiseFloor, threshold, leaked: signal > threshold };
};

/** One trial's worth of samples: two same-path sets and the set being compared to them. */
export interface TimingSamples {
  readonly knownA: number[];
  readonly knownB: number[];
  readonly unknown: number[];
}

export interface TimingOutcome {
  readonly leaked: boolean;
  /** Every trial actually run, first to last, for reporting on failure. */
  readonly trials: readonly TimingVerdict[];
}

/**
 * Run `collect` up to `attempts` times, stopping at the first trial that shows no leak.
 *
 * Idea (3) above. A verdict of `leaked` therefore means *every* independent trial saw a gap larger
 * than same-path jitter could explain, which contention cannot produce but an awaited Argon2 hash
 * produces every time. On a quiet machine the first trial passes and the rest are never run.
 */
export const measureUntilClean = async (
  collect: () => Promise<TimingSamples>,
  attempts = 3,
): Promise<TimingOutcome> => {
  const trials: TimingVerdict[] = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { knownA, knownB, unknown } = await collect();
    const verdict = timingVerdict(knownA, knownB, unknown);
    trials.push(verdict);
    if (!verdict.leaked) break;
  }

  return { leaked: trials.every((trial) => trial.leaked), trials };
};

/** A one-line summary of a set of trials, for `expect(...)` failure output. */
export const describeTrials = (trials: readonly TimingVerdict[]): string =>
  trials
    .map(
      (trial, index) =>
        `#${index + 1} signal ${trial.signal.toFixed(3)} vs threshold ${trial.threshold.toFixed(3)}`,
    )
    .join('; ');
