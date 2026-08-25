/**
 * T-036 — `CreateMerchantStoreDto`: `POST /merchants/:id/stores` (TC-12/TC-13).
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateMerchantStoreDto } from '@/modules/merchants/dto/create-merchant-store.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(CreateMerchantStoreDto, body));
  return Object.fromEntries(
    errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]),
  );
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { storeCode: 'S001', name: 'Main Store', ...overrides };
}

describe('CreateMerchantStoreDto', () => {
  it('accepts a fully valid body with only the required fields', async () => {
    await expect(failures(validBody())).resolves.toEqual({});
  });

  it('accepts every optional field populated', async () => {
    await expect(
      failures(
        validBody({
          address: '1 Main St',
          city: 'Kuala Lumpur',
          state: 'WP',
          postalCode: '50000',
          region: 'Central',
          latitude: 3.139,
          longitude: 101.6869,
        }),
      ),
    ).resolves.toEqual({});
  });

  it('has no tenantId/merchantId field at all', () => {
    const props = Object.getOwnPropertyNames(new CreateMerchantStoreDto());
    expect(props).not.toContain('tenantId');
    expect(props).not.toContain('merchantId');
  });

  it('rejects an empty or over-width storeCode', async () => {
    expect((await failures(validBody({ storeCode: '' }))).storeCode).toBeDefined();
    expect((await failures(validBody({ storeCode: 'x'.repeat(51) }))).storeCode).toBeDefined();
  });

  it('rejects an out-of-range latitude/longitude', async () => {
    expect((await failures(validBody({ latitude: 90.1 }))).latitude).toBeDefined();
    expect((await failures(validBody({ longitude: 180.1 }))).longitude).toBeDefined();
  });

  it('accepts boundary latitude/longitude values', async () => {
    await expect(failures(validBody({ latitude: 90, longitude: -180 }))).resolves.toEqual({});
  });
});
