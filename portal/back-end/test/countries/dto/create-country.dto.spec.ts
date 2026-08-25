/**
 * T-030 — `CreateCountryDto`: `POST /countries`.
 *
 * TC-3/TC-4/TC-17 are asserted end to end against the real `ValidationPipe` at the HTTP layer in
 * production; this suite asserts the same rules one layer down, directly against
 * `class-validator`, which is the only practical way to cover ICU-rejection branches (a
 * `RangeError` from `Intl.DateTimeFormat` is not something an HTTP request can be asked for) —
 * the same reasoning `test/me/me.dto.spec.ts` gives for `isIanaTimeZone`.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createCountryRequestSchema } from '@reward-portal/shared';
// `flattenValidationErrors` — the exact function `main.ts`'s global `ValidationPipe` uses
// (`validation.exception-factory.ts`) — is reused here rather than re-implemented, so a nested
// `admin.email` failure (a `ValidateNested()` child, which a shallow `error.property` map would
// silently drop) is asserted the same way production actually reports it.
import { flattenValidationErrors } from '@/common/errors/validation.exception-factory';
import { CreateCountryDto } from '@/modules/countries/dto/create-country.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(CreateCountryDto, body));
  const flat: Record<string, string[]> = {};
  for (const detail of flattenValidationErrors(errors)) {
    flat[detail.field] = [...(flat[detail.field] ?? []), detail.code];
  }
  return flat;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 'MY',
    name: 'Malaysia',
    timezone: 'Asia/Kuala_Lumpur',
    currencyCode: 'MYR',
    dialingCode: '+60',
    ...overrides,
  };
}

describe('CreateCountryDto', () => {
  it('accepts a fully valid body', async () => {
    await expect(failures(validBody())).resolves.toEqual({});
  });

  it('upper-cases code and currencyCode before validation (implementation note 2)', () => {
    const instance = plainToInstance(
      CreateCountryDto,
      validBody({ code: 'my', currencyCode: 'myr' }),
    );
    expect(instance.code).toBe('MY');
    expect(instance.currencyCode).toBe('MYR');
  });

  it('leaves a non-string code/currencyCode untouched for @IsString to reject on its own terms', () => {
    const instance = plainToInstance(CreateCountryDto, validBody({ code: 42, currencyCode: 42 }));
    expect(instance.code).toBe(42);
    expect(instance.currencyCode).toBe(42);
  });

  it('rejects an invalid ISO-3166-1 code (TC-3)', async () => {
    const result = await failures(validBody({ code: 'XYZ' }));
    // Length fails first (3 chars); the custom constraint also runs and is asserted separately.
    expect(result.code).toBeDefined();
  });

  it('the custom constraint alone rejects a 2-letter code that is not a real country', async () => {
    const result = await failures(validBody({ code: 'ZZ' }));
    expect(result.code).toContain('IS_ISO3166_ALPHA2_COUNTRY_CODE');
  });

  it('rejects an unknown timezone (TC-4)', async () => {
    const result = await failures(validBody({ timezone: 'Mars/Olympus_Mons' }));
    expect(result.timezone).toContain('IS_IANA_TIME_ZONE');
  });

  it('rejects an unknown currency code', async () => {
    const result = await failures(validBody({ currencyCode: 'ZZZ' }));
    expect(result.currencyCode).toContain('IS_ISO4217_CURRENCY_CODE');
  });

  it('rejects an empty name', async () => {
    const result = await failures(validBody({ name: '' }));
    expect(result.name).toContain('MIN_LENGTH');
  });

  it('rejects a name over the varchar(100) column width', async () => {
    const result = await failures(validBody({ name: 'x'.repeat(101) }));
    expect(result.name).toContain('MAX_LENGTH');
  });

  it('rejects a malformed dialing code', async () => {
    for (const dialingCode of ['abc', '+', '12345678', '+00000']) {
      const result = await failures(validBody({ dialingCode }));
      expect(result.dialingCode).toBeDefined();
    }
  });

  it('accepts a dialing code with or without a leading +', async () => {
    await expect(failures(validBody({ dialingCode: '60' }))).resolves.toEqual({});
    await expect(failures(validBody({ dialingCode: '+1' }))).resolves.toEqual({});
  });

  it('rejects an unexpected top-level field under the whitelist (TC-17 — the DTO half)', async () => {
    const errors = await validate(
      plainToInstance(CreateCountryDto, validBody({ id: 999 })),
      // `forbidNonWhitelisted` mirrors main.ts's global ValidationPipe configuration.
      { whitelist: true, forbidNonWhitelisted: true },
    );
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['id']).toHaveProperty('whitelistValidation');
  });

  it('validates a nested admin object', async () => {
    const result = await failures(validBody({ admin: { email: 'not-an-email', displayName: '' } }));
    expect(result['admin.email']).toContain('IS_EMAIL');
    expect(result['admin.displayName']).toContain('MIN_LENGTH');
  });

  it('accepts a valid nested admin object', async () => {
    await expect(
      failures(validBody({ admin: { email: 'admin@example.invalid', displayName: 'Admin' } })),
    ).resolves.toEqual({});
  });

  it('is a subset of the shared Zod request schema (front end and back end agree on the shape)', () => {
    // Both reject the same well-formed body's absence of required keys the same way; this is a
    // structural smoke test, not a byte-for-byte schema mirror (class-validator constraints and
    // Zod refinements are expressed differently) — see country.schema.ts's own header.
    expect(createCountryRequestSchema.safeParse(validBody()).success).toBe(true);
    expect(createCountryRequestSchema.safeParse(validBody({ id: 999 })).success).toBe(false);
  });
});
