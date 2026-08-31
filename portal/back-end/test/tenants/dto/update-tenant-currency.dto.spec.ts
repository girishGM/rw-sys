/**
 * T-126 — `UpdateTenantCurrencyDto`: `PATCH /tenants/:id/currencies/:currencyId`.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateTenantCurrencyDto } from '@/modules/tenants/dto/update-tenant-currency.dto';

describe('UpdateTenantCurrencyDto', () => {
  it('accepts an empty body — every field is optional', async () => {
    const errors = await validate(plainToInstance(UpdateTenantCurrencyDto, {}));
    expect(errors).toEqual([]);
  });

  it('accepts a valid status', async () => {
    const errors = await validate(plainToInstance(UpdateTenantCurrencyDto, { status: 'inactive' }));
    expect(errors).toEqual([]);
  });

  it('rejects a status outside ck_tc_status', async () => {
    const errors = await validate(plainToInstance(UpdateTenantCurrencyDto, { status: 'bogus' }));
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isIn');
  });

  it('has no currencyCode field at all — immutable once created', () => {
    expect(Object.getOwnPropertyNames(new UpdateTenantCurrencyDto())).not.toContain('currencyCode');
  });

  it('rejects an unexpected top-level field under the whitelist', async () => {
    const errors = await validate(
      plainToInstance(UpdateTenantCurrencyDto, { currencyCode: 'MYR' }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['currencyCode']).toHaveProperty('whitelistValidation');
  });
});
