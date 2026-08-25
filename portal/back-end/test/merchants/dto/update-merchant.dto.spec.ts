/**
 * T-036 — `UpdateMerchantDto`: `PATCH /merchants/:id`.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateMerchantDto } from '@/modules/merchants/dto/update-merchant.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(UpdateMerchantDto, body));
  return Object.fromEntries(
    errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]),
  );
}

describe('UpdateMerchantDto', () => {
  it('accepts an empty body — every field is optional', async () => {
    await expect(failures({})).resolves.toEqual({});
  });

  it('accepts a full body, including status and confirm', async () => {
    await expect(
      failures({
        name: 'New Name',
        description: 'Updated',
        contactEmail: 'ops@acme.example',
        contactPhone: '+60123456789',
        website: 'https://acme.example',
        status: 'inactive',
        confirm: true,
      }),
    ).resolves.toEqual({});
  });

  it('rejects an unknown status', async () => {
    const result = await failures({ status: 'deleted' });
    expect(result.status).toContain('isIn');
  });

  it('rejects a non-boolean confirm', async () => {
    const result = await failures({ confirm: 'yes' });
    expect(result.confirm).toContain('isBoolean');
  });

  it('has no merchantCode/tenantId/countryCode field at all — immutable business keys', () => {
    const props = Object.getOwnPropertyNames(new UpdateMerchantDto());
    expect(props).not.toContain('merchantCode');
    expect(props).not.toContain('tenantId');
    expect(props).not.toContain('countryCode');
  });

  it('rejects an unexpected top-level field under the whitelist', async () => {
    const errors = await validate(plainToInstance(UpdateMerchantDto, { merchantCode: 'X' }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['merchantCode']).toHaveProperty('whitelistValidation');
  });
});
