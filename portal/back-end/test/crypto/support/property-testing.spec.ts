/**
 * T-016 — tests for the property-testing harness itself.
 *
 * `field-crypto.property.spec.ts` is only as good as the generator underneath it, and that
 * generator is this task's own code rather than a library with its own test suite (see
 * `property-testing.ts`'s header for why `fast-check` could not be installed here). An
 * untested generator that returned `''` every time would make every property in the AR-17
 * suite pass while testing nothing at all — the exact failure mode a property suite is
 * supposed to protect against.
 *
 * So the harness gets the two guarantees the AR-17 suite actually relies on, asserted here:
 *
 *   1. **Determinism.** Same seed ⇒ same inputs, so a reported failure reproduces.
 *   2. **Reach.** The generators really do produce empty strings, very long strings, astral
 *      code points and the awkward literals — not just 25 characters of ASCII.
 *
 * Plus the two failure paths: a failing property must fail loudly with its counterexample, and
 * a property that skips everything must not be reported as passing.
 */
import fc, { assert, oneof, property, Rng, string } from './property-testing';

describe('property-testing harness — determinism', () => {
  it('produces an identical sequence for an identical seed', () => {
    const draw = (seed: number): number[] => {
      const rng = new Rng(seed);
      return Array.from({ length: 20 }, () => rng.int(0, 1_000_000));
    };
    expect(draw(1234)).toEqual(draw(1234));
    expect(draw(1234)).not.toEqual(draw(1235));
  });

  it('runs a property over the same inputs every time', () => {
    const collect = (): string[] => {
      const seen: string[] = [];
      assert(
        property(string({ maxLength: 12 }), string({ maxLength: 12 }), (a, b) => {
          seen.push(`${a}|${b}`);
        }),
        { numRuns: 50, seed: 99 },
      );
      return seen;
    };
    expect(collect()).toEqual(collect());
  });

  it('runs exactly numRuns times when nothing is skipped', () => {
    let runs = 0;
    assert(
      property(string(), string(), () => {
        runs += 1;
      }),
      { numRuns: 137, seed: 7 },
    );
    expect(runs).toBe(137);
  });
});

describe('property-testing harness — generator reach', () => {
  /** Draws `count` values from `arbitrary` with a fixed seed. */
  function sample<T>(arbitrary: { generate(rng: Rng): T }, count: number, seed = 42): T[] {
    const rng = new Rng(seed);
    return Array.from({ length: count }, () => arbitrary.generate(rng));
  }

  it('string() reaches both the empty string and the requested maximum length', () => {
    const values = sample(fc.string({ maxLength: 100_000 }), 2_000);
    expect(values.some((v) => v.length === 0)).toBe(true);
    // The size bias must not cost the large cases entirely — that is the whole point of TC-9.
    expect(Math.max(...values.map((v) => v.length))).toBeGreaterThan(1_000);
    // ...nor may it make every case large, or the boundary cases are never reached.
    expect(values.filter((v) => v.length <= 25).length).toBeGreaterThan(values.length / 2);
    expect(values.every((v) => /^[\x20-\x7e]*$/.test(v))).toBe(true);
  });

  it('string() honours minLength', () => {
    expect(sample(fc.string({ minLength: 3, maxLength: 9 }), 300).every((v) => v.length >= 3)).toBe(
      true,
    );
  });

  it('fullUnicodeString() reaches astral planes and never emits a lone surrogate', () => {
    const values = sample(fc.fullUnicodeString({ maxLength: 30 }), 500);
    const joined = values.join('');
    expect([...joined].some((c) => (c.codePointAt(0) ?? 0) > 0xffff)).toBe(true);
    // Every surrogate present must be part of a well-formed pair.
    expect(joined.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')).not.toMatch(/[\uD800-\uDFFF]/);
  });

  it('stringOf() draws only from the supplied alphabet', () => {
    const values = sample(fc.stringOf(fc.constantFrom('a', '.', '\uD800'), { maxLength: 20 }), 200);
    expect(values.every((v) => /^[a.\uD800]*$/.test(v))).toBe(true);
    expect(values.some((v) => v.includes('\uD800'))).toBe(true);
  });

  it('constantFrom() eventually yields every constant', () => {
    expect(new Set(sample(fc.constantFrom('a', 'b', 'c'), 200))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('oneof() draws from every branch', () => {
    const values = sample(oneof(fc.integer({ min: 1, max: 5 }), fc.uuid()), 200);
    expect(values.some((v) => typeof v === 'number')).toBe(true);
    expect(values.some((v) => typeof v === 'string')).toBe(true);
  });

  it('integer()/nat() stay inside their bounds', () => {
    expect(sample(fc.integer({ min: -5, max: 5 }), 500).every((v) => v >= -5 && v <= 5)).toBe(true);
    expect(sample(fc.nat({ max: 3 }), 200).every((v) => v >= 0 && v <= 3)).toBe(true);
    expect(new Set(sample(fc.nat({ max: 3 }), 200)).size).toBe(4);
  });

  it('uuid() produces v4-shaped, distinct values', () => {
    const values = sample(fc.uuid(), 100);
    expect(
      values.every((v) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v),
      ),
    ).toBe(true);
    expect(new Set(values).size).toBe(100);
  });

  it('tuple() and map() compose', () => {
    const values = sample(
      fc.tuple(fc.constantFrom('t'), fc.integer({ min: 1, max: 9 })).map(([t, n]) => `${t}:${n}`),
      50,
    );
    expect(values.every((v) => /^t:[1-9]$/.test(v))).toBe(true);
  });
});

describe('property-testing harness — failure reporting', () => {
  it('rethrows with the seed, the run index and the counterexample', () => {
    expect(() =>
      assert(
        property(fc.constantFrom('boom'), fc.constantFrom(1), (value) => {
          expect(value).toBe('not boom');
        }),
        { numRuns: 10, seed: 4242 },
      ),
    ).toThrow(/seed=4242[\s\S]*Counterexample: "boom" \(length 4\), 1/);
  });

  it('reports the true length of a truncated counterexample', () => {
    const long = 'x'.repeat(5_000);
    expect(() =>
      assert(
        property(fc.constantFrom(long), fc.constantFrom(0), () => {
          throw new Error('nope');
        }),
        { numRuns: 1, seed: 1 },
      ),
    ).toThrow(/length 5000/);
  });

  it('preserves the original error as the cause', () => {
    const original = new Error('the real reason');
    try {
      assert(
        property(fc.constantFrom(1), fc.constantFrom(2), () => {
          throw original;
        }),
        { numRuns: 1, seed: 1 },
      );
      throw new Error('assert() should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('the real reason');
      expect((err as { cause?: unknown }).cause).toBe(original);
    }
  });

  it('skips runs whose precondition fails, and still reaches numRuns', () => {
    let executed = 0;
    assert(
      property(fc.integer({ min: 0, max: 9 }), fc.constantFrom(0), (value) => {
        fc.pre(value % 2 === 0);
        executed += 1;
      }),
      { numRuns: 40, seed: 11 },
    );
    expect(executed).toBe(40);
  });

  it('fails rather than passing vacuously when every run is skipped', () => {
    expect(() =>
      assert(
        property(fc.constantFrom(1), fc.constantFrom(2), () => {
          fc.pre(false);
        }),
        { numRuns: 5, seed: 1 },
      ),
    ).toThrow(/not actually being tested/);
  });
});
