/**
 * T-126 — `CreateTenantCurrencyDto`: `POST /tenants/:id/currencies`.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { flattenValidationErrors } from '@/common/errors/validation.exception-factory';
import { CreateTenantCurrencyDto } from '@/modules/tenants/dto/create-tenant-currency.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(CreateTenantCurrencyDto, body));
  const flat: Record<string, string[]> = {};
  for (const detail of flattenValidationErrors(errors)) {
    flat[detail.field] = [...(flat[detail.field] ?? []), detail.code];
  }
  return flat;
}

describe('CreateTenantCurrencyDto', () => {
  it('accepts a valid body with only the required field', async () => {
    await expect(failures({ currencyCode: 'MYR' })).resolves.toEqual({});
  });

  it('accepts isDefault explicitly set', async () => {
    await expect(failures({ currencyCode: 'MYR', isDefault: true })).resolves.toEqual({});
  });

  it('upper-cases currencyCode before validation', () => {
    const instance = plainToInstance(CreateTenantCurrencyDto, { currencyCode: 'myr' });
    expect(instance.currencyCode).toBe('MYR');
  });

  it('leaves a non-string currencyCode untouched for @IsString/@Matches to reject on its own terms', () => {
    const instance = plainToInstance(CreateTenantCurrencyDto, { currencyCode: 42 });
    expect(instance.currencyCode).toBe(42);
  });

  it('rejects a currencyCode that is not exactly 3 upper-case letters', async () => {
    expect((await failures({ currencyCode: 'MY' })).currencyCode).toBeDefined();
    expect((await failures({ currencyCode: 'MYRA' })).currencyCode).toBeDefined();
    expect((await failures({ currencyCode: '123' })).currencyCode).toBeDefined();
  });

  it('rejects an unexpected top-level field under the whitelist', async () => {
    const errors = await validate(
      plainToInstance(CreateTenantCurrencyDto, { currencyCode: 'MYR', tenantId: 999 }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['tenantId']).toHaveProperty('whitelistValidation');
  });
});
