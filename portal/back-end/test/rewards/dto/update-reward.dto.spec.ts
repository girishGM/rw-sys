import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { updateRewardRequestSchema } from '@reward-portal/shared';
import { UpdateRewardDto } from '@/modules/rewards/dto/update-reward.dto';

async function errorsFor(body: Record<string, unknown>) {
  return validate(plainToInstance(UpdateRewardDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('UpdateRewardDto', () => {
  it('accepts an empty body (a no-op update)', async () => {
    expect(await errorsFor({})).toHaveLength(0);
  });

  it('accepts every field, including status and connectorConfig', async () => {
    const errors = await errorsFor({
      name: 'New name',
      description: null,
      rewardType: 'points',
      deliveryMode: 'scheduled',
      connectorType: 'webhook',
      connectorConfig: { webhookSecret: 'whsec_123' },
      maintenanceWindowEnabled: true,
      maintenanceSchedule: { start: '01:00' },
      retryEnabled: false,
      retryConfig: { maxAttempts: 5 },
      merchantId: null,
      status: 'inactive',
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects systemCode — immutable, never accepted here', async () => {
    const errors = await errorsFor({ systemCode: 'NEW_CODE' });
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['systemCode']).toHaveProperty('whitelistValidation');
  });

  it('rejects categoryId/subCategoryId — immutable-by-replacement (T-118), never accepted here', async () => {
    const errors = await errorsFor({ categoryId: 2, subCategoryId: 3 });
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['categoryId']).toHaveProperty('whitelistValidation');
    expect(flat['subCategoryId']).toHaveProperty('whitelistValidation');
  });

  it('rejects an unknown status', async () => {
    const errors = await errorsFor({ status: 'archived' });
    expect(errors.some((error) => error.property === 'status')).toBe(true);
  });

  it('rejects malformed connectorConfig', async () => {
    const errors = await errorsFor({ connectorConfig: 'not-an-object' });
    expect(errors.some((error) => error.property === 'connectorConfig')).toBe(true);
  });

  it('is a subset of the shared Zod request schema', () => {
    expect(updateRewardRequestSchema.safeParse({ status: 'inactive' }).success).toBe(true);
    expect(updateRewardRequestSchema.safeParse({ systemCode: 'X' }).success).toBe(false);
    expect(updateRewardRequestSchema.safeParse({ categoryId: 1 }).success).toBe(false);
  });
});
