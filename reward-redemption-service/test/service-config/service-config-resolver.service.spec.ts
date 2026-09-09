/**
 * T-RR-006 — `ServiceConfigResolverService`, unit-tested against a fake `ServiceConfigRepository`
 * (this service's own coercion/precedence logic is pure and doesn't need a real DB round trip to
 * verify — `ServiceConfigRepository`'s own `findFirstMatch` SQL is covered separately, against the
 * real database, by `service-config.repository.spec.ts`).
 *
 * The fake below implements the same first-match-wins precedence `FIND_FIRST_MATCH_SQL` does
 * (`service-config.repository.ts`), so these tests exercise the resolver's own contract exactly as
 * a real repository would present it, without opening a socket.
 */
import type { ServiceConfigRow } from '@/database/models/service-config.model';
import {
  ServiceConfigNotFoundError,
  ServiceConfigResolverService,
  ServiceConfigTypeError,
} from '@/modules/service-config/service-config-resolver.service';
import type {
  ServiceConfigRepository,
  ServiceConfigScopeContext,
} from '@/modules/service-config/service-config.repository';

let nextId = 1;

function makeRow(
  overrides: Partial<ServiceConfigRow> & Pick<ServiceConfigRow, 'config_key'>,
): ServiceConfigRow {
  return {
    id: nextId++,
    scope_level: 'GLOBAL',
    scope_ref: null,
    config_value: '',
    value_type: 'string',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/** Fake repository mirroring `FIND_FIRST_MATCH_SQL`'s own precedence walk in plain JS, seeded
 * from a flat list of rows. */
class FakeServiceConfigRepository implements Pick<ServiceConfigRepository, 'findFirstMatch'> {
  constructor(private readonly rows: ServiceConfigRow[]) {}

  async findFirstMatch(
    configKey: string,
    context: ServiceConfigScopeContext,
  ): Promise<ServiceConfigRow | null> {
    const forKey = this.rows.filter((row) => row.config_key === configKey);
    if (context.campaignCode !== undefined) {
      const match = forKey.find(
        (row) => row.scope_level === 'CAMPAIGN' && row.scope_ref === context.campaignCode,
      );
      if (match) return match;
    }
    if (context.tenantCode !== undefined) {
      const match = forKey.find(
        (row) => row.scope_level === 'TENANT' && row.scope_ref === context.tenantCode,
      );
      if (match) return match;
    }
    if (context.countryCode !== undefined) {
      const match = forKey.find(
        (row) => row.scope_level === 'COUNTRY' && row.scope_ref === context.countryCode,
      );
      if (match) return match;
    }
    return forKey.find((row) => row.scope_level === 'GLOBAL' && row.scope_ref === null) ?? null;
  }
}

function resolverWith(rows: ServiceConfigRow[]): ServiceConfigResolverService {
  return new ServiceConfigResolverService(
    new FakeServiceConfigRepository(rows) as unknown as ServiceConfigRepository,
  );
}

describe('T-RR-006 — ServiceConfigResolverService', () => {
  // TC-1.
  it('TC-1: resolves a GLOBAL int row with no scope context given, returning a number not a string', async () => {
    const resolver = resolverWith([
      makeRow({ config_key: 'some.knob', config_value: '5', value_type: 'int' }),
    ]);

    const value = await resolver.resolve('some.knob', 'int');

    expect(value).toBe(5);
    expect(typeof value).toBe('number');
  });

  // TC-2.
  it('TC-2: a matching CAMPAIGN row wins over a GLOBAL row for the same key', async () => {
    const resolver = resolverWith([
      makeRow({ config_key: 'some.knob', config_value: '5', value_type: 'int' }),
      makeRow({
        config_key: 'some.knob',
        scope_level: 'CAMPAIGN',
        scope_ref: 'CAMP1',
        config_value: '99',
        value_type: 'int',
      }),
    ]);

    const value = await resolver.resolve('some.knob', 'int', { campaignCode: 'CAMP1' });

    expect(value).toBe(99);
  });

  // TC-2 (negative half): the same seed, resolved with a non-matching campaign, still falls to GLOBAL.
  it('a non-matching campaignCode falls through to the GLOBAL row rather than the CAMPAIGN row', async () => {
    const resolver = resolverWith([
      makeRow({ config_key: 'some.knob', config_value: '5', value_type: 'int' }),
      makeRow({
        config_key: 'some.knob',
        scope_level: 'CAMPAIGN',
        scope_ref: 'CAMP1',
        config_value: '99',
        value_type: 'int',
      }),
    ]);

    const value = await resolver.resolve('some.knob', 'int', { campaignCode: 'CAMP_OTHER' });

    expect(value).toBe(5);
  });

  // TC-3.
  it('TC-3: falls through CAMPAIGN (no match) to a matching TENANT row', async () => {
    const resolver = resolverWith([
      makeRow({
        config_key: 'some.knob',
        scope_level: 'TENANT',
        scope_ref: 'TEN1',
        config_value: '42',
        value_type: 'int',
      }),
    ]);

    const value = await resolver.resolve('some.knob', 'int', {
      campaignCode: 'CAMP_NO_MATCH',
      tenantCode: 'TEN1',
    });

    expect(value).toBe(42);
  });

  it('falls through TENANT (no match) to a matching COUNTRY row', async () => {
    const resolver = resolverWith([
      makeRow({
        config_key: 'some.knob',
        scope_level: 'COUNTRY',
        scope_ref: 'US',
        config_value: '7',
        value_type: 'int',
      }),
    ]);

    const value = await resolver.resolve('some.knob', 'int', {
      tenantCode: 'TEN_NO_MATCH',
      countryCode: 'US',
    });

    expect(value).toBe(7);
  });

  // TC-4.
  it('TC-4: throws ServiceConfigNotFoundError when no row exists at any scope, including no GLOBAL row', async () => {
    const resolver = resolverWith([]);

    await expect(resolver.resolve('unconfigured.knob', 'int')).rejects.toThrow(
      ServiceConfigNotFoundError,
    );
  });

  // TC-5.
  it('TC-5: throws ServiceConfigTypeError for a boolean-typed row whose value is "yes", never treating it as truthy', async () => {
    const resolver = resolverWith([
      makeRow({ config_key: 'flag.knob', config_value: 'yes', value_type: 'boolean' }),
    ]);

    await expect(resolver.resolve('flag.knob', 'boolean')).rejects.toThrow(ServiceConfigTypeError);
  });

  it('resolves a boolean-typed row of "false" as the literal boolean false, not a falsy string', async () => {
    const resolver = resolverWith([
      makeRow({ config_key: 'flag.knob', config_value: 'false', value_type: 'boolean' }),
    ]);

    const value = await resolver.resolve('flag.knob', 'boolean');

    expect(value).toBe(false);
  });

  // TC-6.
  it('TC-6: throws on a json-typed row whose value is malformed JSON', async () => {
    const resolver = resolverWith([
      makeRow({ config_key: 'json.knob', config_value: '{not-valid-json', value_type: 'json' }),
    ]);

    await expect(resolver.resolve('json.knob', 'json')).rejects.toThrow();
  });

  it('resolves a well-formed json-typed row to its parsed value', async () => {
    const resolver = resolverWith([
      makeRow({
        config_key: 'json.knob',
        config_value: JSON.stringify({ a: 1, b: [true, false] }),
        value_type: 'json',
      }),
    ]);

    await expect(resolver.resolve('json.knob', 'json')).resolves.toEqual({
      a: 1,
      b: [true, false],
    });
  });

  it('resolves a string-typed row as the raw text, unmodified', async () => {
    const resolver = resolverWith([
      makeRow({ config_key: 'string.knob', config_value: 'hello world', value_type: 'string' }),
    ]);

    await expect(resolver.resolve('string.knob', 'string')).resolves.toBe('hello world');
  });

  it('throws ServiceConfigTypeError for a positive integer parsed from a non-numeric string, never silently returning NaN', async () => {
    const resolver = resolverWith([
      makeRow({ config_key: 'bad.int.knob', config_value: 'not-a-number', value_type: 'int' }),
    ]);

    await expect(resolver.resolve('bad.int.knob', 'int')).rejects.toThrow(ServiceConfigTypeError);
  });

  it("throws ServiceConfigTypeError when the caller requests a type that does not match the row's own stored value_type", async () => {
    const resolver = resolverWith([
      makeRow({ config_key: 'mismatched.knob', config_value: '5', value_type: 'string' }),
    ]);

    await expect(resolver.resolve('mismatched.knob', 'int')).rejects.toThrow(
      ServiceConfigTypeError,
    );
  });
});
