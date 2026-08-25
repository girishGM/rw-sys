/**
 * T-030 — `UpdateCountryDto`: `PATCH /countries/:id`. `code` is deliberately absent (immutable
 * business key); `confirm` is the deactivation-warning override (implementation note 7).
 */
import 'reflect-metadata';
import { getMetadataStorage, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { updateCountryRequestSchema } from '@reward-portal/shared';
import { UpdateCountryDto } from '@/modules/countries/dto/update-country.dto';

function declaredProperties(): string[] {
  const metadata = getMetadataStorage().getTargetValidationMetadatas(
    UpdateCountryDto,
    '',
    false,
    false,
    undefined,
  );
  return [...new Set(metadata.map((entry) => entry.propertyName))].sort();
}

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(UpdateCountryDto, body));
  return Object.fromEntries(
    errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]),
  );
}

describe('UpdateCountryDto', () => {
  it('never declares `code` — the business key is immutable', () => {
    expect(declaredProperties()).not.toContain('code');
  });

  it('names the same fields as the shared Zod schema', () => {
    expect(Object.keys(updateCountryRequestSchema.shape).sort()).toEqual(declaredProperties());
  });

  it('accepts an empty body — every field is optional', async () => {
    await expect(failures({})).resolves.toEqual({});
  });

  it('accepts a full body', async () => {
    await expect(
      failures({
        name: 'Malaysia',
        timezone: 'Asia/Kuala_Lumpur',
        currencyCode: 'MYR',
        dialingCode: '+60',
        isHq: true,
        status: 'inactive',
        confirm: true,
      }),
    ).resolves.toEqual({});
  });

  it('upper-cases currencyCode before validation', () => {
    const instance = plainToInstance(UpdateCountryDto, { currencyCode: 'myr' });
    expect(instance.currencyCode).toBe('MYR');
  });

  it('leaves a non-string currencyCode untouched for @IsString to reject on its own terms', () => {
    const instance = plainToInstance(UpdateCountryDto, { currencyCode: 42 });
    expect(instance.currencyCode).toBe(42);
  });

  it('rejects a status outside ck_countries_status', async () => {
    const result = await failures({ status: 'deleted' });
    expect(result.status).toContain('isIn');
  });

  it('rejects a non-boolean confirm', async () => {
    const result = await failures({ confirm: 'yes' });
    expect(result.confirm).toContain('isBoolean');
  });

  it('rejects an unexpected field under the whitelist (TC-17)', async () => {
    const errors = await validate(plainToInstance(UpdateCountryDto, { id: 999 }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['id']).toHaveProperty('whitelistValidation');
  });
});
