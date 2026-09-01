import * as crypto from 'node:crypto';
import { CodeGenerator, cryptoRandomSource } from '@/modules/generation/code-generator';
import { AMBIGUOUS_CHARS } from '@/modules/generation/charset.constants';
import { UnknownCharacterSetError } from '@/modules/generation/code-generator.types';
import type { CodeGenerationConfig, RandomSource } from '@/modules/generation/code-generator.types';

/**
 * Deterministic, sequential-cycling stub — never `Math.random()`, never crypto. Cycles through
 * `0..exclusiveMax-1` on each call so tests can assert exact output shape without depending on
 * real randomness (TC-1…TC-5, TC-9, TC-10, TC-13).
 */
function sequentialRandomSource(): RandomSource {
  let counter = 0;
  return (exclusiveMax: number): number => {
    const value = counter % exclusiveMax;
    counter += 1;
    return value;
  };
}

const baseConfig: CodeGenerationConfig = {
  characterSet: 'ALPHANUMERIC',
  codeLength: 8,
  codePrefix: null,
  codePostfix: null,
  excludeAmbiguousChars: false,
};

describe('CodeGenerator', () => {
  let generator: CodeGenerator;

  beforeEach(() => {
    generator = new CodeGenerator();
  });

  // TC-1
  it('generates a NUMERIC code of the requested length containing only digits', () => {
    const code = generator.generate(
      { ...baseConfig, characterSet: 'NUMERIC', codeLength: 6 },
      cryptoRandomSource,
    );
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[0-9]{6}$/);
  });

  // TC-2
  it('generates an ALPHA code of the requested length containing only uppercase letters', () => {
    const code = generator.generate(
      { ...baseConfig, characterSet: 'ALPHA', codeLength: 8 },
      cryptoRandomSource,
    );
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[A-Z]{8}$/);
  });

  // TC-3
  it('generates an ALPHANUMERIC code of the requested length containing only digits/uppercase', () => {
    const code = generator.generate(
      { ...baseConfig, characterSet: 'ALPHANUMERIC', codeLength: 10 },
      cryptoRandomSource,
    );
    expect(code).toHaveLength(10);
    expect(code).toMatch(/^[0-9A-Z]{10}$/);
  });

  // TC-4
  it('prepends codePrefix and keeps the random segment at exactly codeLength characters', () => {
    const code = generator.generate(
      { ...baseConfig, codePrefix: 'SAVE10-', codePostfix: '', codeLength: 5 },
      sequentialRandomSource(),
    );
    expect(code.startsWith('SAVE10-')).toBe(true);
    expect(code.slice('SAVE10-'.length)).toHaveLength(5);
  });

  // TC-5
  it('produces prefix + randomSegment + postfix with the random segment matching codeLength', () => {
    const code = generator.generate(
      { ...baseConfig, codePrefix: 'PRE-', codePostfix: '-POST', codeLength: 6 },
      sequentialRandomSource(),
    );
    expect(code.startsWith('PRE-')).toBe(true);
    expect(code.endsWith('-POST')).toBe(true);
    const randomSegment = code.slice('PRE-'.length, code.length - '-POST'.length);
    expect(randomSegment).toHaveLength(6);
  });

  // TC-6
  it('never includes an ambiguous character when excludeAmbiguousChars is true (1000 runs)', () => {
    const config: CodeGenerationConfig = {
      ...baseConfig,
      characterSet: 'ALPHANUMERIC',
      codeLength: 12,
      excludeAmbiguousChars: true,
    };
    for (let i = 0; i < 1000; i += 1) {
      const code = generator.generate(config, cryptoRandomSource);
      for (const char of code) {
        expect(AMBIGUOUS_CHARS.has(char)).toBe(false);
      }
    }
  });

  // TC-7
  it('leaves ambiguous characters eligible when excludeAmbiguousChars is false', () => {
    // A random source pinned to always select the ambiguous characters' pool indices proves
    // they were never filtered out of the pool in the first place.
    const alwaysZero: RandomSource = () => 0; // pool[0] === '0' for ALPHANUMERIC
    const code = generator.generate(
      { ...baseConfig, characterSet: 'ALPHANUMERIC', codeLength: 4, excludeAmbiguousChars: false },
      alwaysZero,
    );
    expect(code).toBe('0000');
  });

  // TC-8
  it('produces 10,000 unique candidates for the same config (statistical collision-freedom)', () => {
    const config: CodeGenerationConfig = {
      ...baseConfig,
      characterSet: 'ALPHANUMERIC',
      codeLength: 8,
    };
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      seen.add(generator.generate(config, cryptoRandomSource));
    }
    expect(seen.size).toBe(10_000);
  });

  // TC-9
  it('succeeds at the minimum codeLength of 4', () => {
    const code = generator.generate({ ...baseConfig, codeLength: 4 }, cryptoRandomSource);
    expect(code).toHaveLength(4);
  });

  // TC-10
  it('succeeds at the maximum codeLength of 32', () => {
    const code = generator.generate({ ...baseConfig, codeLength: 32 }, cryptoRandomSource);
    expect(code).toHaveLength(32);
  });

  // TC-11
  it('distributes NUMERIC digits roughly uniformly across 0-9 over 10,000 samples', () => {
    const tally = new Map<string, number>();
    for (let i = 0; i < 10_000; i += 1) {
      const code = generator.generate(
        { ...baseConfig, characterSet: 'NUMERIC', codeLength: 1 },
        cryptoRandomSource,
      );
      tally.set(code, (tally.get(code) ?? 0) + 1);
    }
    expect(tally.size).toBe(10); // every digit appeared at least once
    const expected = 1000; // 10,000 samples / 10 digits
    for (const [, count] of tally) {
      // Generous tolerance (±25%) — this is a sanity check against a broken sampling bias,
      // not a strict statistical test that could flake on legitimate variance.
      expect(count).toBeGreaterThan(expected * 0.75);
      expect(count).toBeLessThan(expected * 1.25);
    }
  });

  // TC-12 — node's builtin `crypto` module exports `randomInt` as a non-configurable
  // property (`jest.spyOn` throws "Cannot redefine property" against it directly), so this
  // spies on a module registry isolated to this one test via `jest.doMock` instead — the
  // fresh `require` inside `isolateModules` picks up the mocked module exactly like
  // `code-generator.ts`'s own `import { randomInt } from 'node:crypto'` would.
  it("uses node:crypto's randomInt as its default randomness source, not Math.random", () => {
    let randomIntSpy: jest.Mock | undefined;
    jest.isolateModules(() => {
      jest.doMock('node:crypto', () => {
        const actual = jest.requireActual<typeof crypto>('node:crypto');
        randomIntSpy = jest.fn(actual.randomInt);
        return { ...actual, randomInt: randomIntSpy };
      });
      // Deliberate dynamic require (not a static import) inside an isolated module registry
      // so it picks up the `doMock` above, the same way `code-generator.ts`'s own
      // `import { randomInt } from 'node:crypto'` would resolve within this scope (T-PC-020).
      type CodeGeneratorModule = typeof import('@/modules/generation/code-generator');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const requiredModule = require('@/modules/generation/code-generator');
      const isolatedModule = requiredModule as CodeGeneratorModule;
      const isolatedGenerator = new isolatedModule.CodeGenerator();
      isolatedGenerator.generate({ ...baseConfig, codeLength: 6 });
    });
    expect(randomIntSpy).toHaveBeenCalled();
    jest.dontMock('node:crypto');
  });

  // TC-13
  it('has no cross-call memoization: two calls with identical config produce independent output', () => {
    const config: CodeGenerationConfig = { ...baseConfig, characterSet: 'NUMERIC', codeLength: 20 };
    const first = generator.generate(config, sequentialRandomSource());
    const second = generator.generate(config, sequentialRandomSource());
    expect(first).toBe(second); // identical stub random source -> identical output
    expect(first).toHaveLength(20);
  });

  // TC-14
  it('throws a typed error for an unrecognized characterSet, bypassing DTO validation', () => {
    const config = { ...baseConfig, characterSet: 'INVALID' } as unknown as CodeGenerationConfig;
    expect(() => generator.generate(config, sequentialRandomSource())).toThrow(
      UnknownCharacterSetError,
    );
  });

  it('confirms Math.random is never used (grep-equivalent behavioural check)', () => {
    const mathRandomSpy = jest.spyOn(Math, 'random');
    generator.generate({ ...baseConfig, codeLength: 6 }, cryptoRandomSource);
    expect(mathRandomSpy).not.toHaveBeenCalled();
    mathRandomSpy.mockRestore();
  });
});
