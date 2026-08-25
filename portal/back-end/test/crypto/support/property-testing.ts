/**
 * T-016 — a minimal, deterministic property-testing harness for the AR-17 suite.
 *
 * ### Why this file exists instead of `fast-check`
 *
 * Architect review AR-17 asks for a `fast-check` property suite over `encrypt`/`decrypt`.
 * `fast-check` is not a dependency of this workspace and **cannot be added from inside this
 * task**: the project's `.claude/settings.json` permits `npm run …` only, so `npm install` is
 * not runnable here, and the package is not in the local npm cache either. The options were
 * (a) ship a red `npm test` — forbidden by AGENT-PROTOCOL R10, (b) drop the property suite —
 * which is the one thing AR-17 specifically asked for on the task the review calls one of the
 * two riskiest in the project, or (c) this: implement the small slice of the `fast-check` API
 * the suite actually uses, in test-support code this task owns.
 *
 * (c) was chosen, and the swap back is deliberately a **one-line change**: the suite's API
 * surface is identical, so once someone runs
 *
 *     npm install --save-dev --workspace back-end fast-check
 *
 * `field-crypto.property.spec.ts` goes back to `import fc from 'fast-check'` and nothing else
 * in it moves. This is flagged as a deviation in the T-016 completion report; the reviewer,
 * not this agent, decides whether to take the dependency.
 *
 * ### What is and is not equivalent
 *
 * Equivalent, and these are what the properties actually depend on:
 *  - thousands of pseudo-random inputs per property, from a **fixed seed**, so a failure
 *    reproduces exactly rather than "sometimes in CI";
 *  - size bias towards short inputs with occasional very large ones — the distribution that
 *    finds boundary bugs, rather than 2,000 uniformly-100kB strings that find only timeouts;
 *  - generators that reach the inputs a hand-written case never does: lone surrogates,
 *    embedded NUL, astral-plane code points, strings made of the envelope separator.
 *
 * **Not** equivalent, and stated plainly rather than glossed over:
 *  - *no shrinking.* `fast-check` reports the smallest failing input; this reports the actual
 *    failing input, its run index and the seed. Diagnosis is slower. Correctness of the
 *    verdict is not affected — a counterexample is a counterexample.
 *  - no `examples`/replay-path plumbing, no coverage-guided generation, no bias towards
 *    previously-failing inputs.
 *
 * Nothing here is imported by `src/`. It is test scaffolding only.
 */

/** Thrown by `pre()` to skip a run whose inputs do not satisfy the property's precondition. */
class PreconditionFailure extends Error {
  constructor() {
    super('property precondition not satisfied');
    this.name = 'PreconditionFailure';
  }
}

/**
 * `mulberry32` — 32-bit, seedable, no dependencies, and identical on every platform and Node
 * version. `Math.random()` is unusable here: it cannot be seeded, so a failure could never be
 * reproduced from the report.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The random source handed to every generator. */
export class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Uniform integer in [min, max], inclusive both ends. */
  int(min: number, max: number): number {
    if (max <= min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** One element of a non-empty array. */
  pick<T>(values: readonly T[]): T {
    return values[this.int(0, values.length - 1)];
  }

  /**
   * A length in [min, max], biased towards the short end.
   *
   * 85% of the time the length stays within 25 of `min`. Without this bias a generator with
   * `maxLength: 100_000` produces nothing but ~50 kB strings, which exercises the same code
   * path 2,000 times and never reaches the empty-string and one-character cases where the
   * bugs live. The remaining 15% still reach the full range, so the large-input case is
   * genuinely covered.
   */
  length(min: number, max: number): number {
    if (max <= min) return min;
    const small = Math.min(max, min + 25);
    return this.float() < 0.85 ? this.int(min, small) : this.int(min, max);
  }
}

/** A value generator. `map` is the only combinator the AR-17 suite needs. */
export interface Arbitrary<T> {
  generate(rng: Rng): T;
  map<U>(transform: (value: T) => U): Arbitrary<U>;
}

class Gen<T> implements Arbitrary<T> {
  constructor(private readonly generator: (rng: Rng) => T) {}

  generate(rng: Rng): T {
    return this.generator(rng);
  }

  map<U>(transform: (value: T) => U): Arbitrary<U> {
    return new Gen<U>((rng) => transform(this.generator(rng)));
  }
}

export interface StringConstraints {
  minLength?: number;
  maxLength?: number;
}

/** Printable ASCII, `fast-check`'s own default alphabet for `string()`. */
const PRINTABLE_ASCII: readonly string[] = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) =>
  String.fromCharCode(0x20 + i),
);

function stringFrom(chars: () => string, constraints: StringConstraints = {}): Arbitrary<string> {
  const min = constraints.minLength ?? 0;
  const max = constraints.maxLength ?? 25;
  return new Gen<string>((rng) => {
    const length = rng.length(min, max);
    let out = '';
    for (let i = 0; i < length; i += 1) out += chars();
    return out;
  });
}

/** Printable-ASCII string. */
export function string(constraints: StringConstraints = {}): Arbitrary<string> {
  const min = constraints.minLength ?? 0;
  const max = constraints.maxLength ?? 25;
  return new Gen<string>((rng) => {
    const length = rng.length(min, max);
    let out = '';
    for (let i = 0; i < length; i += 1) out += rng.pick(PRINTABLE_ASCII);
    return out;
  });
}

/**
 * Any Unicode string, astral planes included. Unpaired surrogates are produced separately by
 * the suite's own `stringOf` generator; this one emits well-formed code points, which is what
 * `fast-check`'s `fullUnicodeString()` does.
 */
export function fullUnicodeString(constraints: StringConstraints = {}): Arbitrary<string> {
  const min = constraints.minLength ?? 0;
  const max = constraints.maxLength ?? 25;
  return new Gen<string>((rng) => {
    const length = rng.length(min, max);
    let out = '';
    for (let i = 0; i < length; i += 1) {
      // Skip the surrogate range D800–DFFF: those are not code points on their own.
      const point = rng.int(0, 0x10ffff - 0x800);
      out += String.fromCodePoint(point < 0xd800 ? point : point + 0x800);
    }
    return out;
  });
}

/** A string built from another generator's characters. */
export function stringOf(
  charArbitrary: Arbitrary<string>,
  constraints: StringConstraints = {},
): Arbitrary<string> {
  return new Gen<string>((rng) =>
    stringFrom(() => charArbitrary.generate(rng), constraints).generate(rng),
  );
}

/** One of a fixed set of values. */
export function constantFrom<T>(...values: readonly T[]): Arbitrary<T> {
  return new Gen<T>((rng) => rng.pick(values));
}

/** The value type a generator produces — lets `oneof` union its arguments' types. */
type ValueOf<A> = A extends Arbitrary<infer T> ? T : never;

/**
 * One of several generators, chosen uniformly. Heterogeneous, like `fast-check`'s: the result
 * type is the union of the inputs', so `oneof(integer(), uuid())` is `Arbitrary<number|string>`
 * rather than an error.
 */
export function oneof<T extends readonly Arbitrary<unknown>[]>(
  ...arbitraries: T
): Arbitrary<ValueOf<T[number]>> {
  return new Gen<ValueOf<T[number]>>(
    (rng) => rng.pick(arbitraries).generate(rng) as ValueOf<T[number]>,
  );
}

export function tuple<A, B>(a: Arbitrary<A>, b: Arbitrary<B>): Arbitrary<[A, B]> {
  return new Gen<[A, B]>((rng) => [a.generate(rng), b.generate(rng)]);
}

export function integer(constraints: { min?: number; max?: number } = {}): Arbitrary<number> {
  const min = constraints.min ?? -2_147_483_648;
  const max = constraints.max ?? 2_147_483_647;
  return new Gen<number>((rng) => rng.int(min, max));
}

export function nat(constraints: { max?: number } = {}): Arbitrary<number> {
  return integer({ min: 0, max: constraints.max ?? 2_147_483_647 });
}

const HEX = '0123456789abcdef';

/** RFC 4122 v4 shape. Only the shape matters here — it is used as a primary key in an AAD. */
export function uuid(): Arbitrary<string> {
  return new Gen<string>((rng) => {
    const hex = (count: number): string => {
      let out = '';
      for (let i = 0; i < count; i += 1) out += HEX[rng.int(0, 15)];
      return out;
    };
    return `${hex(8)}-${hex(4)}-4${hex(3)}-${HEX[rng.int(8, 11)]}${hex(3)}-${hex(12)}`;
  });
}

/**
 * Skips the current run when its generated inputs are not ones the property is stated over
 * (e.g. "two *different* AADs"). Same semantics as `fast-check`'s `fc.pre`.
 */
export function pre(condition: boolean): void {
  if (!condition) throw new PreconditionFailure();
}

/** What `assert()` consumes. `property()` is the only thing that produces one. */
export interface PropertyRunner {
  readonly arbitraries: readonly Arbitrary<unknown>[];
  run(values: readonly unknown[]): void;
}

class PropertyImpl implements PropertyRunner {
  constructor(
    readonly arbitraries: readonly Arbitrary<unknown>[],
    private readonly predicate: (...values: readonly unknown[]) => void,
  ) {}

  run(values: readonly unknown[]): void {
    this.predicate(...values);
  }
}

export function property<A, B>(
  a: Arbitrary<A>,
  b: Arbitrary<B>,
  predicate: (a: A, b: B) => void,
): PropertyRunner;
export function property<A, B, C>(
  a: Arbitrary<A>,
  b: Arbitrary<B>,
  c: Arbitrary<C>,
  predicate: (a: A, b: B, c: C) => void,
): PropertyRunner;
export function property<A, B, C, D>(
  a: Arbitrary<A>,
  b: Arbitrary<B>,
  c: Arbitrary<C>,
  d: Arbitrary<D>,
  predicate: (a: A, b: B, c: C, d: D) => void,
): PropertyRunner;
export function property<A, B, C, D, E, F>(
  a: Arbitrary<A>,
  b: Arbitrary<B>,
  c: Arbitrary<C>,
  d: Arbitrary<D>,
  e: Arbitrary<E>,
  f: Arbitrary<F>,
  predicate: (a: A, b: B, c: C, d: D, e: E, f: F) => void,
): PropertyRunner;
export function property(...args: readonly unknown[]): PropertyRunner {
  const predicate = args[args.length - 1] as (...values: readonly unknown[]) => void;
  const arbitraries = args.slice(0, -1) as readonly Arbitrary<unknown>[];
  return new PropertyImpl(arbitraries, predicate);
}

export interface AssertParameters {
  /** Number of *successful* runs required. Skipped runs (see `pre`) do not count. */
  numRuns?: number;
  /** Fixed by every caller in this suite, on purpose — see the file header. */
  seed?: number;
}

/**
 * Runs `property` until `numRuns` runs have executed, then returns. On the first failure it
 * rethrows an error naming the seed, the run index and the exact inputs, so the failure can be
 * reproduced by hand.
 *
 * The skip budget stops a mis-stated precondition (`pre(false)`) from looking like a passing
 * property: a suite that skips every run must fail, not report success over zero cases.
 */
export function assert(property: PropertyRunner, parameters: AssertParameters = {}): void {
  const numRuns = parameters.numRuns ?? 100;
  const seed = parameters.seed ?? 0;
  const rng = new Rng(seed);
  const maxSkips = numRuns * 10;

  let successes = 0;
  let skips = 0;

  while (successes < numRuns) {
    const values = property.arbitraries.map((arbitrary) => arbitrary.generate(rng));
    try {
      property.run(values);
      successes += 1;
    } catch (err) {
      if (err instanceof PreconditionFailure) {
        skips += 1;
        if (skips > maxSkips) {
          throw new Error(
            `Property skipped ${skips} runs without reaching ${numRuns} successful ones ` +
              `(seed=${seed}). The precondition rejects almost every generated input, so this ` +
              `property is not actually being tested.`,
          );
        }
        continue;
      }
      throw new Error(
        `Property failed on run ${successes + 1} of ${numRuns} (seed=${seed}).\n` +
          `Counterexample: ${values.map(describe).join(', ')}\n` +
          `Cause: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}

/**
 * Renders one generated input for a failure message. Long strings are truncated with their
 * true length reported — a 100 kB counterexample in a Jest failure is unreadable, and the
 * length is the part that matters.
 */
function describe(value: unknown): string {
  if (typeof value !== 'string') return JSON.stringify(value) ?? String(value);
  const shown =
    value.length > 120 ? `${JSON.stringify(value.slice(0, 120))}…` : JSON.stringify(value);
  return `${shown} (length ${value.length})`;
}

/**
 * Default export shaped like `fast-check`'s, so the property spec's body is byte-identical to
 * what it would be against the real library.
 */
export const fc = {
  assert,
  property,
  pre,
  string,
  fullUnicodeString,
  stringOf,
  constantFrom,
  oneof,
  tuple,
  integer,
  nat,
  uuid,
};

export default fc;
