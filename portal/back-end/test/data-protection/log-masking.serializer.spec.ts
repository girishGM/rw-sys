/**
 * T-017 — enforcement point ③. TC-6 … TC-12 live here, plus the structural guarantees the
 * serialiser inherits from T-014's `redact()` (totality, purity, cycle and depth bounds).
 *
 * The two layers are tested separately and together: the policy walk (which is *correct* but
 * key-based, so blind to a mis-named secret) and the final regex sweep (which is *shape*-based, so
 * blind to anything without a distinctive shape). The point of the design is that neither is
 * trusted alone, so neither is asserted alone.
 */
import {
  BINARY,
  CIRCULAR,
  captureCallSite,
  containerOf,
  createLogMaskingSerialiser,
  defaultSweepAlarm,
  isPlainObject,
  MAX_LOG_DEPTH,
  maskForLog,
  REDACTED,
  SWEEP_REPLACEMENT_PREFIX,
  sweep,
  sweepPatterns,
  treatValue,
  TRUNCATED,
  type SweepHit,
} from '@/common/data-protection/log-masking.serializer';
import { maskFull } from '@/common/data-protection/mask.strategies';
import { HASH_PREFIX, MASK_CHAR } from '@/common/data-protection/data-protection.constants';
import { FAIL_CLOSED_POLICY, type PolicyLookup } from '@/common/data-protection/policy.service';
import { FIXTURE_POLICIES, policy, policySet } from './support/policies';

const policies = policySet(FIXTURE_POLICIES);
const options = { policies, onSweepHit: (): void => undefined };

/** A lookup whose every method throws — the unavailable-cache case (TC-21). */
const brokenPolicies: PolicyLookup = {
  resolveColumn: () => {
    throw new Error('cache down');
  },
  resolveDtoField: () => {
    throw new Error('cache down');
  },
  resolveFieldName: () => {
    throw new Error('cache down');
  },
  policyFor: () => null,
  columnPoliciesFor: () => [],
  protectedTables: () => [],
};

describe('the four log treatments', () => {
  // TC-6 — `dto.LoginRequest.password` is log_treatment 'omit'.
  it('omits a key entirely rather than masking it (TC-6)', () => {
    const out = maskForLog({ email: 'a@x.com', password: 'hunter2' }, options) as Record<
      string,
      unknown
    >;
    expect('password' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  // TC-7 — `merchants.contact_email` is mask/email.
  it('masks an email with the email strategy (TC-7)', () => {
    const out = maskForLog({ contactEmail: 'john@example.com' }, options) as Record<
      string,
      unknown
    >;
    expect(out.contactEmail).toBe(`j${MASK_CHAR.repeat(4)}@example.com`);
  });

  it('hashes for correlation without disclosing', () => {
    const set = policySet([
      policy({ policyKey: 'a.b.customer_ref', classification: 'pii', logTreatment: 'hash' }),
    ]);
    const out = maskForLog({ customerRef: 'CUST-99' }, { policies: set }) as Record<
      string,
      unknown
    >;
    expect(String(out.customerRef).startsWith(HASH_PREFIX)).toBe(true);
    expect(String(out.customerRef)).not.toContain('CUST-99');
  });

  it('passes a plain field through and still walks into it', () => {
    const out = maskForLog({ code: 'MY', nested: { password: 'x' } }, options) as Record<
      string,
      unknown
    >;
    expect(out.code).toBe('MY');
    expect('password' in (out.nested as object)).toBe(false);
  });

  it('hashes a non-string via its JSON form, so objects do not all share one digest', () => {
    const resolved = { ...FAIL_CLOSED_POLICY, logTreatment: 'hash' as const };
    expect(treatValue({ a: 1 }, 'hash', resolved)).not.toBe(treatValue({ a: 2 }, 'hash', resolved));
    expect(String(treatValue(42, 'hash', resolved)).startsWith(HASH_PREFIX)).toBe(true);
  });

  it('hashes an unserialisable value without throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const resolved = { ...FAIL_CLOSED_POLICY, logTreatment: 'hash' as const };
    expect(String(treatValue(cyclic, 'hash', resolved)).startsWith(HASH_PREFIX)).toBe(true);
  });
});

describe('depth, arrays, cycles and exotic values', () => {
  // TC-8 — a secret five levels deep inside arrays.
  it('masks at depth, through arrays (TC-8)', () => {
    const payload = { a: [{ b: [{ c: [{ d: [{ password: 'deep-secret' }] }] }] }] };
    expect(JSON.stringify(maskForLog(payload, options))).not.toContain('deep-secret');
  });

  // TC-9 — a self-referencing object.
  it('handles a self-reference without looping (TC-9)', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    cyclic.list = [cyclic];
    const out = maskForLog(cyclic, options) as Record<string, unknown>;
    expect(out.self).toBe(CIRCULAR);
    expect((out.list as unknown[])[0]).toBe(CIRCULAR);
  });

  it('renders a repeated sibling twice — only a genuine ancestor cycle is CIRCULAR', () => {
    const shared = { code: 'MY' };
    const out = maskForLog({ a: shared, b: shared }, options) as Record<string, unknown>;
    expect(out.a).toEqual({ code: 'MY' });
    expect(out.b).toEqual({ code: 'MY' });
  });

  it('truncates beyond the depth bound rather than exhausting the stack', () => {
    let deep: Record<string, unknown> = { code: 'MY' };
    for (let i = 0; i <= MAX_LOG_DEPTH + 2; i += 1) deep = { next: deep };
    expect(JSON.stringify(maskForLog(deep, options))).toContain(TRUNCATED);
  });

  it('renders binary as a marker rather than printing key material byte by byte', () => {
    expect(maskForLog({ k: Buffer.from('secret') }, options)).toEqual({ k: BINARY });
    expect(maskForLog({ k: new Uint8Array([1, 2]) }, options)).toEqual({ k: BINARY });
    expect(maskForLog({ k: new ArrayBuffer(4) }, options)).toEqual({ k: BINARY });
  });

  it('keeps Dates and stringifies RegExps, Symbols, BigInts and functions', () => {
    const date = new Date('2026-08-18T00:00:00.000Z');
    const anonymous: Record<string, unknown> = {};
    // `{ anon: () => 1 }` would be *named* `anon` by the engine's name inference. A function
    // expression inside an array literal gets no name, which is the only way to reach the
    // "anonymous" branch.
    anonymous.anon = [function () {}][0];
    const out = maskForLog(
      { date, re: /ab+c/i, sym: Symbol('s'), big: 10n, fn: function named() {}, ...anonymous },
      options,
    ) as Record<string, unknown>;
    expect(out.date).toBe(date);
    expect(out.re).toBe('/ab+c/i');
    expect(String(out.sym)).toContain('Symbol(s)');
    expect(out.big).toBe('10n');
    expect(out.fn).toBe('[Function named]');
    expect(out.anon).toBe('[Function anonymous]');
  });

  it('hashes a value JSON.stringify returns undefined for, without producing "undefined"', () => {
    // `JSON.stringify(() => 1)` is `undefined`, not a string — the `?? String(value)` branch.
    const resolved = { ...FAIL_CLOSED_POLICY, logTreatment: 'hash' as const };
    expect(String(treatValue(() => 1, 'hash', resolved)).startsWith(HASH_PREFIX)).toBe(true);
    expect(String(treatValue(undefined, 'hash', resolved)).startsWith(HASH_PREFIX)).toBe(true);
  });

  it('walks Sets and Maps', () => {
    const out = maskForLog(
      {
        s: new Set(['a', 'b']),
        m: new Map<unknown, unknown>([
          ['password', 'x'],
          [1, 'one'],
        ]),
      },
      options,
    ) as Record<string, unknown>;
    expect(out.s).toEqual(['a', 'b']);
    expect('password' in (out.m as object)).toBe(false);
    expect((out.m as Record<string, unknown>)['1']).toBe('one');
  });

  it('renders an Error with its stack, and masks its custom properties', () => {
    const error = Object.assign(new Error('boom'), { password: 'x', sql: 'SELECT 1' });
    const out = maskForLog({ error }, options) as { error: Record<string, unknown> };
    expect(out.error.message).toBe('boom');
    expect(typeof out.error.stack).toBe('string');
    expect(out.error.sql).toBe('SELECT 1');
    expect('password' in out.error).toBe(false);
  });

  it('survives a getter that throws, because a serialiser must never fail a log call', () => {
    const hostile = {
      get boom(): string {
        throw new Error('nope');
      },
      ok: 1,
    };
    expect(maskForLog(hostile, options)).toEqual({ boom: '[UNREADABLE]', ok: 1 });
  });

  it('passes primitives and null through untouched', () => {
    expect(maskForLog(null, options)).toBeNull();
    expect(maskForLog(undefined, options)).toBeUndefined();
    expect(maskForLog(7, options)).toBe(7);
    expect(maskForLog('plain text', options)).toBe('plain text');
  });

  it('never mutates its input', () => {
    const input = { password: 'hunter2', nested: { contactEmail: 'a@x.com' } };
    const snapshot = JSON.stringify(input);
    maskForLog(input, options);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('T-014 key-pattern fallback', () => {
  it('redacts a sensitive-looking key the policy table has never heard of', () => {
    const out = maskForLog({ refreshTokenHash: 'abc' }, options) as Record<string, unknown>;
    expect(out.refreshTokenHash).toBe(REDACTED);
  });

  it('lets an explicit policy row win over the pattern, even when more permissive', () => {
    // `email` matches no T-014 pattern, but this proves the precedence direction generally: an
    // explicit `plain` row on a pattern-matching key is honoured, because somebody decided it.
    const set = policySet([
      policy({ policyKey: 'a.b.token_kind', classification: 'internal', logTreatment: 'plain' }),
    ]);
    const out = maskForLog({ token_kind: 'bearer' }, { policies: set }) as Record<string, unknown>;
    expect(out.token_kind).toBe('bearer');
  });
});

describe('container-aware resolution (TC-12)', () => {
  /** The two markers `containerOf` duck-types on. */
  class FakeUser {
    static getTableName(): { tableName: string; schema: string } {
      return { tableName: 'portal_users', schema: 'reward_portal' };
    }
    getDataValue(): unknown {
      return undefined;
    }
    email = 'john@example.com';
    preferredLocale = 'en';
  }

  it('omits an unlisted column of a secret-classified table (TC-12)', () => {
    const out = maskForLog({ user: new FakeUser() }, options) as {
      user: Record<string, unknown>;
    };
    // `email` has a row: masked, not omitted.
    expect(out.user.email).toBe(`j${MASK_CHAR.repeat(4)}@example.com`);
    // `preferred_locale` has none, and the table is `secret`: gone.
    expect('preferredLocale' in out.user).toBe(false);
  });

  it('reads a plain string table name too', () => {
    class Flat {
      static getTableName(): string {
        return 'reward_portal.portal_users';
      }
      getDataValue(): unknown {
        return undefined;
      }
      preferredLocale = 'en';
    }
    expect(containerOf(new Flat())).toBe('reward_portal.portal_users');
    const out = maskForLog({ u: new Flat() }, options) as { u: Record<string, unknown> };
    expect('preferredLocale' in out.u).toBe(false);
  });

  it('omits the schema when the model has none', () => {
    class NoSchema {
      static getTableName(): { tableName: string } {
        return { tableName: 'widgets' };
      }
      getDataValue(): unknown {
        return undefined;
      }
    }
    expect(containerOf(new NoSchema())).toBe('widgets');
  });

  it('treats a non-model as an ordinary object', () => {
    expect(containerOf({})).toBeNull();
    expect(containerOf({ getDataValue: 1 })).toBeNull();
    expect(containerOf({ getDataValue: () => 1 })).toBeNull();
  });

  it('degrades to name-based lookup when getTableName throws or is malformed', () => {
    class Hostile {
      static getTableName(): never {
        throw new Error('nope');
      }
      getDataValue(): unknown {
        return undefined;
      }
    }
    class Weird {
      static getTableName(): unknown {
        return 42;
      }
      getDataValue(): unknown {
        return undefined;
      }
    }
    expect(containerOf(new Hostile())).toBeNull();
    expect(containerOf(new Weird())).toBeNull();
  });
});

describe('fail-closed (TC-21)', () => {
  it('omits every field when the policy lookup throws', () => {
    const out = maskForLog({ a: 1, campaignName: 'Launch' }, { policies: brokenPolicies });
    expect(out).toEqual({});
  });
});

describe('the final regex sweep (TC-10, TC-11)', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const ARGON = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaGhhc2hoYXNo';
  const PEM = '-----BEGIN PRIVATE KEY-----\nMIIBVwIBADAN\n-----END PRIVATE KEY-----';
  const CT = 'v1.fld_2026_01.YWJjZGVmZ2hpamts.MTIzNDU2Nzg5MDEyMzQ1Ng==.c2VjcmV0';

  const hits: SweepHit[] = [];
  const capture = { policies, onSweepHit: (hit: SweepHit) => hits.push(hit) };
  beforeEach(() => {
    hits.length = 0;
  });

  // TC-10 — a raw JWT under an innocuous key, with no policy row anywhere.
  it('catches a JWT logged under a harmless key and raises a WARN (TC-10)', () => {
    const out = maskForLog({ note: `bearer ${JWT}` }, capture) as Record<string, unknown>;
    expect(String(out.note)).not.toContain('eyJ');
    expect(String(out.note)).toContain(`${SWEEP_REPLACEMENT_PREFIX}jwt]`);
    expect(hits).toEqual([{ pattern: 'jwt', count: 1, callSite: expect.any(String) }]);
  });

  /**
   * TC-11 — an Argon2 hash.
   *
   * Asserting the **salt and the digest** are gone, not merely that the `$argon2` prefix is. The
   * weaker assertion is what hid a real defect until TC-25 exercised the same value: the sweep's
   * character class excluded `,`, so the match ended at `m=65536` and everything after the first
   * PHC parameter comma — including both secrets — survived in the log line. A hash whose prefix
   * is redacted and whose digest is not has been redacted in the one place that does not matter.
   */
  it('catches an Argon2 hash, salt and digest included (TC-11)', () => {
    const out = maskForLog({ note: ARGON }, capture) as Record<string, unknown>;
    expect(String(out.note)).not.toContain('$argon2');
    expect(String(out.note)).not.toContain('c29tZXNhbHQ');
    expect(String(out.note)).not.toContain('aGFzaGhhc2hoYXNo');
    expect(String(out.note)).toBe(`${SWEEP_REPLACEMENT_PREFIX}argon2]`);
    expect(hits[0].pattern).toBe('argon2');
  });

  /** The terminators that still bound the match, so the sweep cannot eat a whole JSON payload. */
  it('stops an Argon2 match at a quote, so neighbouring fields survive', () => {
    const out = maskForLog(
      { note: `{"password_hash":"${ARGON}","campaignName":"Launch"}` },
      capture,
    ) as Record<string, unknown>;
    expect(String(out.note)).not.toContain('aGFzaGhhc2hoYXNo');
    expect(String(out.note)).toContain('"campaignName":"Launch"');
  });

  it('catches a PEM block, header through footer', () => {
    const out = maskForLog({ note: PEM }, capture) as Record<string, unknown>;
    expect(String(out.note)).not.toContain('MIIBVwIBADAN');
    expect(hits[0].pattern).toBe('pem');
  });

  it('catches a truncated PEM block with no footer', () => {
    const out = maskForLog({ note: '-----BEGIN RSA PRIVATE KEY-----\nMIIBVwIB' }, capture);
    expect(JSON.stringify(out)).not.toContain('MIIBVwIB');
    expect(hits[0].pattern).toBe('pem');
  });

  it('catches a v1. ciphertext embedded in a longer string', () => {
    const out = maskForLog({ note: `value=${CT} end` }, capture) as Record<string, unknown>;
    expect(String(out.note)).not.toContain('v1.fld_2026_01');
    expect(hits[0].pattern).toBe('ciphertext');
  });

  it('replaces a ciphertext that is a whole leaf, without needing the sweep', () => {
    const out = maskForLog({ note: CT }, { policies, finalRegexSweep: false }) as Record<
      string,
      unknown
    >;
    expect(out.note).toBe(`${SWEEP_REPLACEMENT_PREFIX}ciphertext]`);
  });

  it('counts every occurrence and reports once per pattern', () => {
    maskForLog({ a: `${JWT} ${JWT}`, b: ARGON }, capture);
    expect(hits).toHaveLength(2);
    expect(hits.find((h) => h.pattern === 'jwt')?.count).toBe(2);
  });

  it('reports nothing when there is nothing to report', () => {
    maskForLog({ code: 'MY', n: 1 }, capture);
    expect(hits).toEqual([]);
  });

  it('can be switched off by config, and then does not redact', () => {
    const out = maskForLog({ note: `x ${JWT}` }, { policies, finalRegexSweep: false }) as Record<
      string,
      unknown
    >;
    expect(String(out.note)).toContain('eyJ');
  });

  it('sweeps into arrays and nested objects, and leaves non-strings alone', () => {
    const out = sweep({ a: [{ b: JWT }], n: 1, nil: null }, () => undefined) as {
      a: { b: string }[];
      n: number;
      nil: null;
    };
    expect(out.a[0].b).toBe(`${SWEEP_REPLACEMENT_PREFIX}jwt]`);
    expect(out.n).toBe(1);
    expect(out.nil).toBeNull();
  });

  it('does not rebuild a Date into {} — plain objects only', () => {
    const date = new Date('2026-08-18T00:00:00.000Z');
    expect((sweep({ date }, () => undefined) as { date: Date }).date).toBe(date);
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(date)).toBe(false);
    expect(isPlainObject([1])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('text')).toBe(false);
  });

  it('uses a fresh RegExp per call, so the first match of a second line is not skipped', () => {
    // A shared `g`-flagged pattern would carry lastIndex between calls. Two independent calls
    // must produce identical output.
    expect(sweep(JWT, () => undefined)).toBe(sweep(JWT, () => undefined));
    expect(sweepPatterns()[0].pattern.lastIndex).toBe(0);
  });
});

describe('captureCallSite', () => {
  it('names the first frame outside this module', () => {
    expect(captureCallSite()).toMatch(/:\d+:\d+$/);
  });

  it('returns null when the platform captured no stack', () => {
    expect(captureCallSite(null)).toBeNull();
  });

  it('skips frames inside the serialiser itself', () => {
    const stack = [
      'Error',
      '    at sweep (/app/src/common/data-protection/log-masking.serializer.ts:1:1)',
      '    at handler (/app/src/modules/foo/foo.service.ts:42:7)',
    ].join('\n');
    expect(captureCallSite(stack)).toBe('/app/src/modules/foo/foo.service.ts:42:7');
  });

  it('returns null when no frame has a recognisable shape', () => {
    expect(captureCallSite('Error\n    at <anonymous>')).toBeNull();
  });
});

describe('createLogMaskingSerialiser', () => {
  it('produces a function a logging library can install', () => {
    const serialise = createLogMaskingSerialiser({ policies, onSweepHit: () => undefined });
    expect(serialise({ password: 'x', code: 'MY' })).toEqual({ code: 'MY' });
  });

  it('says so when the call site could not be determined, rather than printing "null"', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      defaultSweepAlarm({ pattern: 'jwt', count: 2, callSite: null });
      expect(String(warn.mock.calls[0][0])).toContain('an unknown call site');
      expect(String(warn.mock.calls[0][0])).not.toContain('null');
    } finally {
      warn.mockRestore();
    }
  });

  it('defaults the alarm to console.warn, naming the remedy', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      maskForLog(
        { note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1' },
        {
          policies,
        },
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('data_protection_policies');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('treatValue', () => {
  it('masks with the resolved strategy, defaulting to full when there is none', () => {
    expect(treatValue('john@x.com', 'mask', { ...FAIL_CLOSED_POLICY, maskStrategy: 'email' })).toBe(
      `j${MASK_CHAR.repeat(4)}@x.com`,
    );
    expect(treatValue('john@x.com', 'mask', { ...FAIL_CLOSED_POLICY, maskStrategy: null })).toBe(
      maskFull(),
    );
  });

  it('returns the value unchanged for plain', () => {
    expect(treatValue('x', 'plain', FAIL_CLOSED_POLICY)).toBe('x');
  });
});
