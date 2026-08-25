/**
 * T-017 — `config/data-protection.json` loading (07-DATA-PROTECTION.md §10).
 *
 * The property under test throughout is the one in the file's header: **no failure mode produces
 * a permissive engine.** Every malformed input below is asserted to land on the restrictive
 * default, and every rejection is asserted to be reported rather than swallowed.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_PATH_ENV_VAR,
  CONFIG_RELATIVE_PATH,
  dataProtectionConfigFactory,
  DEFAULT_DATA_PROTECTION_CONFIG,
  findConfigPath,
  loadDataProtectionConfig,
  normaliseRouteOverrideKey,
  parseDataProtectionConfig,
  type ConfigProblem,
} from '@/common/data-protection/data-protection.config';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 't017-config-'));
}

function writeConfig(dir: string, contents: string): string {
  const path = join(dir, CONFIG_RELATIVE_PATH);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  return path;
}

/** Collects the problems reported by one parse. */
function parseWith(raw: unknown): {
  config: ReturnType<typeof parseDataProtectionConfig>;
  problems: string[];
} {
  const problems: string[] = [];
  const config = parseDataProtectionConfig(raw, (path, reason) =>
    problems.push(`${path}: ${reason}`),
  );
  return { config, problems };
}

describe('the shipped file', () => {
  it('is found by the upward search and parses without a single problem', () => {
    const loaded = loadDataProtectionConfig();
    expect(loaded.path).not.toBeNull();
    expect(loaded.problems).toEqual([]);
  });

  it('carries §10 defaults: fail-closed logging and masked responses', () => {
    const { config } = loadDataProtectionConfig();
    expect(config.enabled).toBe(true);
    expect(config.failClosed).toBe(true);
    expect(config.logging.defaultTreatment).toBe('omit');
    expect(config.logging.finalRegexSweep).toBe(true);
    expect(config.response.defaultVisibility).toBe('masked');
    expect(config.reveal.rateLimitPerHour).toBe(30);
    expect(config.transport.mode).toBe('fields');
    expect(config.atRest.bindRecordIdAsAAD).toBe(true);
  });

  it('contains no key material or credential (R4)', () => {
    const { config } = loadDataProtectionConfig();
    // A structural assertion rather than a grep: nothing in the schema can carry a secret,
    // because every leaf is a boolean, a small integer or a closed enum.
    expect(config.atRest.defaultAlgorithm).toBe('aes_256_gcm');
    expect(JSON.stringify(config)).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
  });
});

describe('locating the file', () => {
  it('returns null when nothing is found above the starting directory', () => {
    expect(findConfigPath(tempDir())).toBeNull();
  });

  it('finds a file placed above the starting directory', () => {
    const root = tempDir();
    const path = writeConfig(root, '{"enabled": true}');
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(findConfigPath(nested)).toBe(path);
  });

  it('prefers an explicit path over the search', () => {
    const root = tempDir();
    const path = writeConfig(root, '{"reveal": {"rateLimitPerHour": 7}}');
    expect(loadDataProtectionConfig({ path }).config.reveal.rateLimitPerHour).toBe(7);
  });

  it('honours the environment override', () => {
    const root = tempDir();
    const path = writeConfig(root, '{"reveal": {"rateLimitPerHour": 9}}');
    const loaded = loadDataProtectionConfig({ env: { [CONFIG_PATH_ENV_VAR]: path } });
    expect(loaded.config.reveal.rateLimitPerHour).toBe(9);
  });

  it('ignores an empty environment override and falls back to the search', () => {
    const loaded = loadDataProtectionConfig({ env: { [CONFIG_PATH_ENV_VAR]: '' } });
    expect(loaded.path).not.toBeNull();
  });
});

describe('failure modes all land on the restrictive default', () => {
  it('reports and defaults when the file is missing', () => {
    const problems: ConfigProblem[] = [];
    const loaded = loadDataProtectionConfig({
      from: tempDir(),
      env: {},
      onProblem: (p) => problems.push(p),
    });
    expect(loaded.config).toEqual(DEFAULT_DATA_PROTECTION_CONFIG);
    expect(loaded.path).toBeNull();
    expect(problems[0].reason).toContain('fail-closed defaults');
  });

  it('reports and defaults when the file is not valid JSON', () => {
    const path = writeConfig(tempDir(), '{ not json');
    const loaded = loadDataProtectionConfig({ path });
    expect(loaded.config).toEqual(DEFAULT_DATA_PROTECTION_CONFIG);
    expect(loaded.problems[0].reason).toContain('not valid JSON');
  });

  it('reports and defaults when the file is unreadable', () => {
    const loaded = loadDataProtectionConfig({ path: join(tempDir(), 'nope.json') });
    expect(loaded.config).toEqual(DEFAULT_DATA_PROTECTION_CONFIG);
    expect(loaded.problems).toHaveLength(1);
  });

  it('reports and defaults when the top level is not an object', () => {
    for (const raw of [null, 42, 'text', ['a']]) {
      const { config, problems } = parseWith(raw);
      expect(config).toEqual(DEFAULT_DATA_PROTECTION_CONFIG);
      expect(problems).toEqual(['$: top level is not an object']);
    }
  });

  it('substitutes the fail-closed value for an unknown enum, and says so', () => {
    const { config, problems } = parseWith({
      logging: { defaultTreatment: 'plian' },
      response: { defaultVisibility: 'visible' },
      transport: { mode: 'sometimes' },
    });
    expect(config.logging.defaultTreatment).toBe('omit');
    expect(config.response.defaultVisibility).toBe('masked');
    expect(config.transport.mode).toBe('fields');
    expect(problems.join('\n')).toContain('fail-closed');
    expect(problems).toHaveLength(3);
  });

  it('rejects a non-boolean, a non-string and a non-integer without adopting them', () => {
    const { config, problems } = parseWith({
      enabled: 'yes',
      failClosed: 0,
      atRest: { defaultAlgorithm: '', bindRecordIdAsAAD: 'true' },
      reveal: { rateLimitPerHour: -1, requireReason: null },
      keys: { rotationWarningDays: 1.5 },
      cache: { ttlSeconds: -5 },
    });
    expect(config.enabled).toBe(true);
    expect(config.failClosed).toBe(true);
    expect(config.atRest.defaultAlgorithm).toBe('aes_256_gcm');
    expect(config.atRest.bindRecordIdAsAAD).toBe(true);
    expect(config.reveal.rateLimitPerHour).toBe(30);
    expect(config.reveal.requireReason).toBe(false);
    expect(config.keys.rotationWarningDays).toBe(30);
    expect(config.cache.ttlSeconds).toBe(300);
    expect(problems).toHaveLength(8);
  });

  it('never echoes a rejected value back into the diagnostic', () => {
    const { problems } = parseWith({ atRest: { defaultAlgorithm: 'SUPER-SECRET-VALUE' } });
    // A non-empty string is accepted for this field, so force the rejection with a number.
    const { problems: typed } = parseWith({ atRest: { defaultAlgorithm: 12345678 } });
    expect(problems).toEqual([]);
    expect(typed[0]).toContain('a number');
    expect(typed[0]).not.toContain('12345678');
  });

  it('accepts zero as a cache TTL — "never expire, invalidate only"', () => {
    const { config, problems } = parseWith({ cache: { ttlSeconds: 0 } });
    expect(config.cache.ttlSeconds).toBe(0);
    expect(problems).toEqual([]);
  });

  it('parses without a reporter, for a caller that does not want the diagnostics', () => {
    expect(() =>
      parseDataProtectionConfig({ logging: { defaultTreatment: 'plian' } }),
    ).not.toThrow();
    expect(parseDataProtectionConfig({ enabled: 'yes' }).enabled).toBe(true);
  });

  it('treats a missing section as absent rather than as invalid', () => {
    const { config, problems } = parseWith({});
    expect(config).toEqual(DEFAULT_DATA_PROTECTION_CONFIG);
    expect(problems).toEqual([]);
  });

  it('treats a section of the wrong type as absent', () => {
    const { config } = parseWith({ logging: 'omit', reveal: [1], transport: 7 });
    expect(config.logging.defaultTreatment).toBe('omit');
    expect(config.reveal.rateLimitPerHour).toBe(30);
    expect(config.transport.mode).toBe('fields');
  });

  it('accepts a valid document unchanged', () => {
    const { config, problems } = parseWith({
      enabled: false,
      failClosed: false,
      transport: { mode: 'full', routeOverrides: { 'post /users': 'off' } },
      atRest: { defaultAlgorithm: 'hmac_sha256', bindRecordIdAsAAD: false },
      logging: { defaultTreatment: 'mask', finalRegexSweep: false },
      response: { defaultVisibility: 'never' },
      reveal: { enabled: false, rateLimitPerHour: 5, requireReason: true },
      keys: { rotationWarningDays: 7 },
      cache: { ttlSeconds: 60 },
    });
    expect(problems).toEqual([]);
    expect(config.enabled).toBe(false);
    expect(config.transport.mode).toBe('full');
    expect(config.transport.routeOverrides['POST /users']).toBe('off');
    expect(config.logging.defaultTreatment).toBe('mask');
    expect(config.reveal.enabled).toBe(false);
  });
});

describe('dataProtectionConfigFactory', () => {
  const sink = { log: [] as string[], warn: [] as string[] };
  const logger = {
    log: (m: string) => sink.log.push(m),
    warn: (m: string) => sink.warn.push(m),
  };
  beforeEach(() => {
    sink.log = [];
    sink.warn = [];
  });

  it('loads the shipped file, reports nothing, and says where it came from', () => {
    const loaded = dataProtectionConfigFactory(logger);
    expect(loaded.enabled).toBe(true);
    expect(loaded.failClosed).toBe(true);
    expect(sink.warn).toEqual([]);
    expect(sink.log[0]).toContain('data-protection.json');
    expect(sink.log[0]).toContain('enabled=true');
    expect(sink.log[0]).toContain('failClosed=true');
  });

  it('says "built-in defaults" when no file was found at all', () => {
    const loaded = dataProtectionConfigFactory(logger, { from: tempDir(), env: {} });
    expect(loaded).toEqual(DEFAULT_DATA_PROTECTION_CONFIG);
    expect(sink.log[0]).toContain('built-in defaults');
    expect(sink.warn[0]).toContain('fail-closed defaults');
  });

  it('reports each problem through the logger it was given', () => {
    const path = writeConfig(tempDir(), '{"logging": {"defaultTreatment": "plian"}}');
    process.env[CONFIG_PATH_ENV_VAR] = path;
    try {
      expect(dataProtectionConfigFactory(logger).logging.defaultTreatment).toBe('omit');
      expect(sink.warn).toHaveLength(1);
      expect(sink.warn[0]).toContain('logging.defaultTreatment');
      expect(sink.warn[0]).toContain('fail-closed');
    } finally {
      delete process.env[CONFIG_PATH_ENV_VAR];
    }
  });

  it('falls back to a console sink when no logger is supplied, for both lines', () => {
    const path = writeConfig(tempDir(), '{"reveal": {"rateLimitPerHour": -3}}');
    process.env[CONFIG_PATH_ENV_VAR] = path;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(dataProtectionConfigFactory().reveal.rateLimitPerHour).toBe(30);
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('reveal.rateLimitPerHour');
      expect(lines[1]).toContain('Data-protection config loaded');
      for (const line of lines) expect(line).toContain('[data-protection]');
    } finally {
      warn.mockRestore();
      delete process.env[CONFIG_PATH_ENV_VAR];
    }
  });
});

describe('routeOverrides', () => {
  it('drops one bad entry without discarding the good ones', () => {
    const { config, problems } = parseWith({
      transport: {
        routeOverrides: { 'POST /users': 'full', 'POST /bad': 'kinda', 'GET /health': 'off' },
      },
    });
    expect(config.transport.routeOverrides).toEqual({
      'POST /users': 'full',
      'GET /health': 'off',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('entry ignored');
  });

  it('normalises §5’s own two-space example and mixed case', () => {
    const { config } = parseWith({
      transport: { routeOverrides: { 'GET  /Health': 'off', 'post /Users': 'full' } },
    });
    expect(config.transport.routeOverrides['GET /health']).toBe('off');
    expect(config.transport.routeOverrides['POST /users']).toBe('full');
  });

  it('reports and empties an overrides value that is not an object', () => {
    const { config, problems } = parseWith({ transport: { routeOverrides: ['a'] } });
    expect(config.transport.routeOverrides).toEqual({});
    expect(problems[0]).toContain('expected an object');
  });

  it('normaliseRouteOverrideKey handles a key with no method', () => {
    expect(normaliseRouteOverrideKey('  /Health  ')).toBe('/health');
    expect(normaliseRouteOverrideKey('get   /a/b  c')).toBe('GET /a/b c');
  });
});
