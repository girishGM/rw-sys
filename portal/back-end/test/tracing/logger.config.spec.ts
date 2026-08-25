/**
 * T-019 — the log schema (08-OBSERVABILITY.md §3) and the masking pipeline.
 *
 * Every assertion here is made on a **real emitted line**: the pipeline is driven by a real
 * `winston` logger writing into a memory transport, and the line is parsed back from the JSON
 * that transport received. Mocking `winston` would test this file's opinion of what winston does
 * with a format chain, which is precisely the part that is easy to get wrong (symbols on the
 * record, formats that drop `level`, `json()` running before masking).
 *
 * TC-7 (fixed keys), TC-9/TC-10 (`actor`/`scope` present, populated or null) and TC-17 (PII
 * masked per T-017 policy) have their form here.
 */
import { createLogger, transports, type Logger } from 'winston';
import Transport from 'winston-transport';
import {
  SERVICE_NAME,
  buildLoggerOptions,
  isPortalLogLevel,
  logPolicyBinding,
  maskingFormat,
  messageKeyFormat,
  resolveLogLevel,
  serviceFormat,
  timestampFormat,
  traceEnvelopeFormat,
  type PortalLogLevel,
} from '@/common/tracing/logger.config';
import { REDACTED } from '@/common/logging/redact';
import type { PolicyLookup, ResolvedPolicy } from '@/common/data-protection/policy.service';
import { TraceContext } from '@/common/tracing/trace-context';
import { authenticatedSnapshot, makeTrace } from './support/trace-fixtures';

/** Collects every emitted line as a parsed object. */
class MemoryTransport extends Transport {
  readonly lines: Record<string, unknown>[] = [];

  log(info: unknown, next: () => void): void {
    this.lines.push(JSON.parse(String((info as Record<symbol, unknown>)[Symbol.for('message')])));
    next();
  }
}

function build(level: PortalLogLevel = 'debug'): { logger: Logger; sink: MemoryTransport } {
  const sink = new MemoryTransport();
  const logger = createLogger(
    buildLoggerOptions({
      level,
      transports: [sink],
      service: { name: SERVICE_NAME, version: '1.4.2', env: 'test', instance: 'pod-7c9' },
    }),
  );
  return { logger, sink };
}

/** A `PolicyLookup` double covering only what a log payload resolves by bare name. */
function policiesFor(byName: Record<string, Partial<ResolvedPolicy>>): PolicyLookup {
  const resolve = (name: string): ResolvedPolicy | null => {
    const found = byName[name];
    if (found === undefined) return null;
    return {
      policyKey: `test.${name}`,
      source: 'column',
      classification: 'pii',
      atRest: 'none',
      blindIndex: false,
      inTransit: 'tls_only',
      logTreatment: 'mask',
      maskStrategy: 'full',
      uiVisibility: 'masked',
      revealRoles: [],
      keyPurpose: null,
      ...found,
    } as ResolvedPolicy;
  };

  return {
    resolveFieldName: resolve,
    resolveColumn: (_table, column) => resolve(column) as ResolvedPolicy,
    resolveDtoField: (_dto, field) => resolve(field) as ResolvedPolicy,
    policyFor: () => null,
    columnPoliciesFor: () => [],
    protectedTables: () => [],
  };
}

afterEach(() => logPolicyBinding.bind(null));

describe('TC-7 — the fixed envelope of 08-OBSERVABILITY.md §3', () => {
  it('emits every fixed key, correctly typed, on an ordinary line', () => {
    const { logger, sink } = build();

    logger.info('request completed', { http: { method: 'GET', status: 200 } });

    const [line] = sink.lines;
    expect(Object.keys(line).sort()).toEqual(
      [
        'actor',
        'correlationId',
        'http',
        'level',
        'msg',
        'requestId',
        'scope',
        'service',
        'spanId',
        'traceId',
        'ts',
      ].sort(),
    );
    expect(typeof line.ts).toBe('string');
    expect(new Date(String(line.ts)).toISOString()).toBe(line.ts);
    expect(line.level).toBe('info');
    expect(line.msg).toBe('request completed');
    expect(line.service).toEqual({
      name: 'portal-api',
      version: '1.4.2',
      env: 'test',
      instance: 'pod-7c9',
    });
  });

  it("renames winston's `message` to §3's `msg` and leaves no synonym behind", () => {
    const { logger, sink } = build();
    logger.warn('something');

    expect(sink.lines[0].msg).toBe('something');
    expect(sink.lines[0]).not.toHaveProperty('message');
    expect(sink.lines[0]).not.toHaveProperty('timestamp');
  });

  it('normalises a non-string message rather than emitting a field of varying type', () => {
    const { logger, sink } = build();

    logger.info({ message: { a: 1 } });
    logger.info({ message: new Error('exploded') });

    expect(sink.lines[0].msg).toBe('{"a":1}');
    expect(sink.lines[1].msg).toBe('exploded');
  });

  it('falls back to String() for a message JSON.stringify has no representation for', () => {
    // `JSON.stringify` returns `undefined` — not a string — for a function, a symbol or
    // `undefined` itself. Returning that would make `msg` typed `string | undefined`, and a
    // fixed-key schema with a sometimes-absent key is not a fixed-key schema.
    const { logger, sink } = build();

    logger.info({ message: (): number => 1 });

    expect(typeof sink.lines[0].msg).toBe('string');
    expect(String(sink.lines[0].msg)).toContain('=>');
  });

  it('survives a message that cannot be serialised', () => {
    const { logger, sink } = build();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => logger.info({ message: cyclic })).not.toThrow();
    expect(sink.lines[0].msg).toBe('[UNSERIALISABLE]');
  });

  it('honours the level threshold', () => {
    const { logger, sink } = build('warn');

    logger.debug('dropped');
    logger.info('dropped');
    logger.warn('kept');
    logger.error('kept');

    expect(sink.lines.map((line) => line.msg)).toEqual(['kept', 'kept']);
  });
});

describe('TC-9 / TC-10 — actor and scope on every line', () => {
  it('TC-9 — populates them from the ambient trace on an authenticated request', () => {
    const { logger, sink } = build();
    const trace = makeTrace({
      correlationId: 'op-abc-123',
      requestId: 'op-abc-123-aabb',
      snapshot: () => authenticatedSnapshot(),
    });

    TraceContext.run(trace, () => logger.info('handled'));

    expect(sink.lines[0]).toMatchObject({
      correlationId: 'op-abc-123',
      requestId: 'op-abc-123-aabb',
      traceId: trace.traceId,
      spanId: trace.spanId,
      actor: { userId: 42, role: 'maker', sessionId: 'sess-1' },
      scope: { countryId: 3, tenantId: 7, merchantId: null },
    });
  });

  it('TC-10 — emits them with null values, and the keys present, when unauthenticated', () => {
    const { logger, sink } = build();

    TraceContext.run(makeTrace(), () => logger.info('anonymous'));

    // The distinction that matters: `actor.userId IS NULL` finds this line; a missing key does
    // not. Asserted with `toEqual` rather than `toMatchObject` so an absent key fails.
    expect(sink.lines[0].actor).toEqual({ userId: null, role: null, sessionId: null });
    expect(sink.lines[0].scope).toEqual({ countryId: null, tenantId: null, merchantId: null });
  });

  it('emits null ids and empty actor/scope outside a request, rather than omitting them', () => {
    const { logger, sink } = build();
    logger.info('boot line');

    expect(sink.lines[0]).toMatchObject({
      correlationId: null,
      requestId: null,
      traceId: null,
      spanId: null,
      actor: { userId: null, role: null, sessionId: null },
      scope: { countryId: null, tenantId: null, merchantId: null },
    });
  });

  it('lets an explicit value win over the ambient trace', () => {
    // T-045's trace assembler logs *about* another request; overwriting its ids would make the
    // line a lie.
    const { logger, sink } = build();

    TraceContext.run(makeTrace({ correlationId: 'ambient1' }), () =>
      logger.info('assembling', { correlationId: 'subject01' }),
    );

    expect(sink.lines[0].correlationId).toBe('subject01');
  });
});

describe('TC-17 — everything passes through the masking serialiser', () => {
  it('falls back to T-014 key-pattern redaction until the policy engine is bound', () => {
    const { logger, sink } = build();

    logger.info('login', { payload: { password: 'hunter2', nested: { refreshToken: 'abc' } } });

    expect(sink.lines[0].payload).toEqual({
      password: REDACTED,
      nested: { refreshToken: REDACTED },
    });
  });

  it('applies the T-017 policy treatment once bound — masked, not deleted', () => {
    logPolicyBinding.bind(policiesFor({ email: { logTreatment: 'mask', maskStrategy: 'email' } }));
    const { logger, sink } = build();

    logger.info('user updated', { email: 'jane.doe@example.com' });

    expect(sink.lines[0].email).not.toBe('jane.doe@example.com');
    expect(String(sink.lines[0].email)).toContain('@example.com');
  });

  it('omits a field whose policy says omit', () => {
    logPolicyBinding.bind(policiesFor({ mfaSecret: { logTreatment: 'omit' } }));
    const { logger, sink } = build();

    logger.info('mfa enrolled', { mfaSecret: 'JBSWY3DPEHPK3PXP', userId: 42 });

    expect(sink.lines[0]).not.toHaveProperty('mfaSecret');
    expect(sink.lines[0].userId).toBe(42);
  });

  it('keeps a policy row stricter than the key pattern from being weakened', () => {
    // A `plain` policy on a key the T-014 pattern would have redacted: the policy wins, because
    // it is an explicit decision by someone who looked at the field. Asserting it here so the
    // precedence documented in T-017 is a tested property rather than a comment.
    logPolicyBinding.bind(policiesFor({ hashAlgorithm: { logTreatment: 'plain' } }));
    const { logger, sink } = build();

    logger.info('crypto', { hashAlgorithm: 'argon2id' });

    expect(sink.lines[0].hashAlgorithm).toBe('argon2id');
  });

  it('sweeps a credential that arrived under an innocuous key, and warns on stderr', () => {
    logPolicyBinding.bind(policiesFor({}));
    const { logger, sink } = build();
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      logger.info('callback received', {
        note: 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlX3ZhbHVl',
      });

      expect(String(sink.lines[0].note)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(String(sink.lines[0].note)).toContain('[REDACTED:jwt]');

      // The alarm goes to stderr as its own JSON line, never back through this logger — routing
      // it here would re-enter the serialiser that raised it (T-017's own note).
      const alarm = JSON.parse(String(stderr.mock.calls[0][0]));
      expect(alarm).toMatchObject({ level: 'warn', sweep: { pattern: 'jwt', count: 1 } });
      expect(sink.lines).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
  });

  it('masks the message string too, not only the metadata', () => {
    logPolicyBinding.bind(policiesFor({}));
    const { logger, sink } = build();
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);

    try {
      logger.error('failed to verify $argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaHZhbHVl');
      expect(String(sink.lines[0].msg)).not.toContain('c29tZXNhbHQ');
      expect(String(sink.lines[0].msg)).not.toContain('aGFzaHZhbHVl');
    } finally {
      stderr.mockRestore();
    }
  });

  it('never throws on a hostile payload — a logging call must not become a 500', () => {
    const { logger, sink } = build();
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;

    expect(() =>
      logger.info('hostile', {
        cyclic,
        buffer: Buffer.from('secret key material'),
        big: BigInt(42),
        throws: {
          get boom(): string {
            throw new Error('getter exploded');
          },
        },
      }),
    ).not.toThrow();

    expect(sink.lines).toHaveLength(1);
    expect(JSON.stringify(sink.lines[0])).not.toContain('secret key material');
  });

  it("keeps winston's level symbol intact through the in-place rewrite", () => {
    // The failure this guards: masking builds a new plain object from `Object.keys`, which drops
    // `Symbol.for('level')` — and a record without it cannot be level-filtered by any transport.
    const { logger, sink } = build('warn');

    logger.debug('must be dropped', { password: 'x' });
    logger.error('must be kept', { password: 'x' });

    expect(sink.lines.map((line) => line.msg)).toEqual(['must be kept']);
    expect(sink.lines[0].password).toBe(REDACTED);
  });
});

describe('the individual formats', () => {
  it('timestampFormat adds ts and nothing else', () => {
    // `transform` is typed `TransformableInfo | boolean` because a format may drop a record.
    // None of ours ever does, which is itself worth asserting.
    const info = timestampFormat().transform({ level: 'info', message: 'x' });
    expect(info).not.toBe(false);
    expect(info).toMatchObject({ level: 'info', message: 'x' });
    expect(typeof (info as unknown as { ts: string }).ts).toBe('string');
  });

  it('serviceFormat adds the identity block', () => {
    const service = { name: 'a', version: 'b', env: 'c', instance: 'd' };
    expect(serviceFormat(service).transform({ level: 'info', message: 'x' })).toMatchObject({
      service,
    });
  });

  it('messageKeyFormat removes `message` in place', () => {
    const info = messageKeyFormat().transform({ level: 'info', message: 'hello' });
    expect(info).toMatchObject({ msg: 'hello' });
    expect(info).not.toHaveProperty('message');
  });

  it('traceEnvelopeFormat and maskingFormat are usable standalone', () => {
    const enveloped = traceEnvelopeFormat().transform({ level: 'info', message: 'x' });
    expect(enveloped).toMatchObject({ correlationId: null });

    const masked = maskingFormat().transform({ level: 'info', message: 'x', token: 'abc' });
    expect(masked).toMatchObject({ token: REDACTED });
  });
});

describe('resolveLogLevel / isPortalLogLevel', () => {
  it.each(['error', 'warn', 'info', 'debug'])('accepts %s', (level) => {
    expect(isPortalLogLevel(level)).toBe(true);
    expect(resolveLogLevel(level, 'production')).toBe(level);
  });

  it.each([undefined, '', 'DEBUG', 'verbose', 'silly', 'trace'])(
    'falls back rather than throwing on %s',
    (level) => {
      expect(isPortalLogLevel(level)).toBe(false);
      expect(resolveLogLevel(level, 'production')).toBe('info');
      expect(resolveLogLevel(level, 'development')).toBe('debug');
      expect(resolveLogLevel(level, 'test')).toBe('info');
    },
  );
});

describe('buildLoggerOptions', () => {
  it('defaults to a console transport when none is supplied', () => {
    const options = buildLoggerOptions({
      level: 'info',
      service: { name: 'a', version: 'b', env: 'c', instance: 'd' },
    });

    expect(Array.isArray(options.transports) ? options.transports : []).toHaveLength(1);
    expect((options.transports as Transport[])[0]).toBeInstanceOf(transports.Console);
  });

  it('never exits the process on a transport error', () => {
    expect(
      buildLoggerOptions({
        level: 'info',
        service: { name: 'a', version: 'b', env: 'c', instance: 'd' },
      }).exitOnError,
    ).toBe(false);
  });
});

describe('logPolicyBinding', () => {
  it('starts unbound and can be reset, so masking never becomes weaker by accident', () => {
    expect(logPolicyBinding.current()).toBeNull();

    const lookup = policiesFor({});
    logPolicyBinding.bind(lookup);
    expect(logPolicyBinding.current()).toBe(lookup);

    logPolicyBinding.bind(null);
    expect(logPolicyBinding.current()).toBeNull();
  });
});
