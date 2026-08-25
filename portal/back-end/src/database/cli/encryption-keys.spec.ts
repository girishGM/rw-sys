/**
 * T-057 (D-2) — unit coverage for the pure, argument-parsing/formatting half of
 * `encryption-keys.ts`. Colocated with the CLI itself (`<rootDir>` already includes
 * `src/**`, `jest.config.js`'s own `testRegex`), the same way `migrate.ts`'s sibling CLI
 * lives with no spec of its own and every crypto module under `src/common/crypto/**` is
 * unit-tested directly against real inputs rather than a mocked database.
 *
 * What this file deliberately does **not** cover: anything that talks to Postgres
 * (`insertKeyRow`, `listKeyRows`, `runProvision`/`runAdd`/`runList`/`runRotate`/`runRetire`,
 * `buildAppConnection`). Real SQL, real constraints (`uq_ek_active_purpose`,
 * `ck_ek_algorithm`) and the real `RotateKeysCommand` engine are exercised end to end against
 * the actual local Postgres instance by `test/database-cli/encryption-keys.e2e-spec.ts` —
 * the same split `test/crypto/support/fake-db.ts`'s own header documents for T-016: a unit
 * double is not evidence the SQL is correct, and a fresh one is not built here only to prove
 * the same thing a real connection already proves better.
 */
import {
  CliUsageError,
  ENV_NAME_PATTERN,
  defaultEnvVar,
  defaultKid,
  expectedAlgorithm,
  parseFlags,
  parseKeyRowArgs,
  pgConstraint,
  sanitiseEnvVarName,
  todayStamp,
} from './encryption-keys';

describe('todayStamp', () => {
  it('is 8 digits, YYYYMMDD', () => {
    expect(todayStamp()).toMatch(/^\d{8}$/);
  });
});

describe('defaultKid', () => {
  it('is "<purpose>_<today>"', () => {
    expect(defaultKid('field')).toBe(`field_${todayStamp()}`);
    expect(defaultKid('blind_index')).toBe(`blind_index_${todayStamp()}`);
  });

  it('is always a valid kid (KID_PATTERN)', () => {
    for (const purpose of ['field', 'blind_index', 'transport', 'token'] as const) {
      expect(defaultKid(purpose)).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    }
  });
});

describe('sanitiseEnvVarName / defaultEnvVar', () => {
  it('uppercases a plain kid', () => {
    expect(sanitiseEnvVarName('field_20260820')).toBe('FIELD_20260820');
  });

  it('replaces hyphens (KID_PATTERN allows them; an env var name cannot)', () => {
    expect(sanitiseEnvVarName('field-key-01')).toBe('FIELD_KEY_01');
    expect(ENV_NAME_PATTERN.test(sanitiseEnvVarName('field-key-01'))).toBe(true);
  });

  it('prefixes a value that would otherwise start with a digit', () => {
    const sanitised = sanitiseEnvVarName('01field');
    expect(ENV_NAME_PATTERN.test(sanitised)).toBe(true);
    expect(sanitised).toBe('K_01FIELD');
  });

  it('defaultEnvVar delegates to sanitiseEnvVarName on the kid', () => {
    expect(defaultEnvVar('bidx_2026_01')).toBe(sanitiseEnvVarName('bidx_2026_01'));
  });
});

describe('expectedAlgorithm', () => {
  it('blind_index -> HMAC-SHA256', () => {
    expect(expectedAlgorithm('blind_index')).toBe('HMAC-SHA256');
  });

  it.each(['field', 'transport', 'token'] as const)('%s -> AES-256-GCM', (purpose) => {
    expect(expectedAlgorithm(purpose)).toBe('AES-256-GCM');
  });
});

describe('parseFlags', () => {
  it('parses zero or more --flag value pairs', () => {
    expect(parseFlags([])).toEqual({});
    expect(parseFlags(['--kid', 'k1', '--env-var', 'K1'])).toEqual({ kid: 'k1', 'env-var': 'K1' });
  });

  it('rejects a bare positional argument', () => {
    expect(() => parseFlags(['oops'])).toThrow(CliUsageError);
  });

  it('rejects a flag with no value', () => {
    expect(() => parseFlags(['--kid'])).toThrow(/requires a value/);
  });

  it('rejects a flag whose "value" is itself another flag', () => {
    expect(() => parseFlags(['--kid', '--env-var', 'X'])).toThrow(/requires a value/);
  });
});

describe('parseKeyRowArgs', () => {
  it('requires a valid purpose', () => {
    expect(() => parseKeyRowArgs([])).toThrow(CliUsageError);
    expect(() => parseKeyRowArgs(['not-a-purpose'])).toThrow(/one of/);
  });

  it('defaults kid, env-var and algorithm from the purpose', () => {
    const args = parseKeyRowArgs(['blind_index']);
    expect(args.purpose).toBe('blind_index');
    expect(args.kid).toBe(defaultKid('blind_index'));
    expect(args.envVar).toBe(defaultEnvVar(args.kid));
    expect(args.algorithm).toBe('HMAC-SHA256');
  });

  it('accepts explicit --kid / --env-var / --algorithm overrides', () => {
    const args = parseKeyRowArgs([
      'field',
      '--kid',
      'my_field_key',
      '--env-var',
      'MY_FIELD_KEY',
      '--algorithm',
      'AES-256-GCM',
    ]);
    expect(args).toEqual({
      purpose: 'field',
      kid: 'my_field_key',
      envVar: 'MY_FIELD_KEY',
      algorithm: 'AES-256-GCM',
    });
  });

  it('rejects a --kid outside KID_PATTERN', () => {
    expect(() => parseKeyRowArgs(['field', '--kid', 'not.a.valid.kid'])).toThrow(/not a valid kid/);
  });

  it('rejects a --env-var that is not a valid environment-variable name', () => {
    expect(() => parseKeyRowArgs(['field', '--env-var', '1BAD'])).toThrow(
      /not a valid environment-variable name/,
    );
  });
});

describe('pgConstraint', () => {
  it('reads err.original.constraint when present', () => {
    expect(pgConstraint({ original: { constraint: 'uq_ek_active_purpose' } })).toBe(
      'uq_ek_active_purpose',
    );
  });

  it('returns undefined for an error with no such shape', () => {
    expect(pgConstraint(new Error('plain'))).toBeUndefined();
    expect(pgConstraint(undefined)).toBeUndefined();
    expect(pgConstraint({})).toBeUndefined();
  });
});

describe('CliUsageError', () => {
  it('carries its own message and name, never a raw stack for the operator to parse', () => {
    const err = new CliUsageError('refused: reason');
    expect(err.message).toBe('refused: reason');
    expect(err.name).toBe('CliUsageError');
    expect(err).toBeInstanceOf(Error);
  });
});
