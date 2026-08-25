/**
 * T-036 — `CreateMerchantActivityDto`: `POST /merchants/:id/activities` (TC-14…TC-19).
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateMerchantActivityDto } from '@/modules/merchants/dto/create-merchant-activity.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(CreateMerchantActivityDto, body));
  return Object.fromEntries(
    errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]),
  );
}

describe('CreateMerchantActivityDto', () => {
  it('accepts activityId alone — a tenant-wide link (TC-14)', async () => {
    await expect(failures({ activityId: 50 })).resolves.toEqual({});
  });

  it('accepts activityId with storeId (TC-16)', async () => {
    await expect(failures({ activityId: 50, storeId: 7 })).resolves.toEqual({});
  });

  it('accepts a commissionRate of 0, 100 and a two-decimal value (TC-19)', async () => {
    await expect(failures({ activityId: 50, commissionRate: 0 })).resolves.toEqual({});
    await expect(failures({ activityId: 50, commissionRate: 100 })).resolves.toEqual({});
    await expect(failures({ activityId: 50, commissionRate: 12.34 })).resolves.toEqual({});
  });

  it('rejects a commissionRate above 100 (TC-17)', async () => {
    const result = await failures({ activityId: 50, commissionRate: 150 });
    expect(result.commissionRate).toContain('isCommissionRate');
  });

  it('rejects a commissionRate with more than 2 decimals (TC-18)', async () => {
    const result = await failures({ activityId: 50, commissionRate: 12.345 });
    expect(result.commissionRate).toContain('isCommissionRate');
  });

  it('rejects a missing activityId', async () => {
    const result = await failures({});
    expect(result.activityId).toBeDefined();
  });

  it('rejects a non-integer or non-positive activityId/storeId', async () => {
    expect((await failures({ activityId: 0 })).activityId).toBeDefined();
    expect((await failures({ activityId: 50, storeId: 0 })).storeId).toBeDefined();
    expect((await failures({ activityId: 1.5 })).activityId).toBeDefined();
  });
});
