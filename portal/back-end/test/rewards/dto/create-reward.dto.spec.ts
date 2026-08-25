import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createRewardRequestSchema } from '@reward-portal/shared';
import { flattenValidationErrors } from '@/common/errors/validation.exception-factory';
import { CreateRewardDto } from '@/modules/rewards/dto/create-reward.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(CreateRewardDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const flat: Record<string, string[]> = {};
  for (const detail of flattenValidationErrors(errors)) {
    flat[detail.field] = [...(flat[detail.field] ?? []), detail.code];
  }
  return flat;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    systemCode: 'CASHBACK_STANDARD',
    name: 'Standard cashback',
    rewardType: 'monetary',
    connectorType: 'internal_api',
    ...overrides,
  };
}

describe('CreateRewardDto', () => {
  it('accepts a minimal valid body', async () => {
    await expect(failures(validBody())).resolves.toEqual({});
  });

  it('accepts every optional field, including connectorConfig (TC-10)', async () => {
    await expect(
      failures(
        validBody({
          description: 'Cashback for standard tier customers',
          deliveryMode: 'batch',
          connectorConfig: { apiKey: 'sk_live_1234', timeoutMs: 5000 },
          maintenanceWindowEnabled: true,
          maintenanceSchedule: { start: '02:00', end: '04:00' },
          retryEnabled: false,
          retryConfig: { maxAttempts: 3 },
          merchantId: 7,
        }),
      ),
    ).resolves.toEqual({});
  });

  it('rejects a lower-case systemCode', async () => {
    const result = await failures(validBody({ systemCode: 'cashback' }));
    expect(result.systemCode).toContain('IS_REWARD_SYSTEM_CODE');
  });

  it('rejects a systemCode over the varchar(50) column width', async () => {
    const result = await failures(validBody({ systemCode: 'A'.repeat(51) }));
    expect(result.systemCode).toContain('MAX_LENGTH');
  });

  it('rejects an empty name', async () => {
    const result = await failures(validBody({ name: '' }));
    expect(result.name).toContain('MIN_LENGTH');
  });

  it('rejects an unrecognised deliveryMode/connectorType — constrained vocabularies (implementation note 6)', async () => {
    const badDelivery = await failures(validBody({ deliveryMode: 'carrier_pigeon' }));
    expect(badDelivery.deliveryMode).toContain('IS_IN');
    const badConnector = await failures(validBody({ connectorType: 'carrier_pigeon' }));
    expect(badConnector.connectorType).toContain('IS_IN');
  });

  it('does not constrain rewardType to an enum — 11-BUDGETS-AND-LIMITS.md §3.1', async () => {
    // Free text is accepted as long as it fits the column width; there is no IS_IN failure.
    const result = await failures(validBody({ rewardType: 'a_brand_new_reward_type' }));
    expect(result.rewardType).toBeUndefined();
  });

  it('rejects malformed connectorConfig (TC-15)', async () => {
    const result = await failures(validBody({ connectorConfig: { nested: { a: 1 } } }));
    expect(result.connectorConfig).toContain('IS_REWARD_CONNECTOR_CONFIG');
  });

  it('rejects an unexpected top-level field under the whitelist (R3 — no client-supplied tenantId)', async () => {
    const errors = await validate(plainToInstance(CreateRewardDto, validBody({ tenantId: 999 })), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['tenantId']).toHaveProperty('whitelistValidation');
  });

  it('rejects a client-supplied status (server always writes active on create)', async () => {
    const errors = await validate(
      plainToInstance(CreateRewardDto, validBody({ status: 'inactive' })),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['status']).toHaveProperty('whitelistValidation');
  });

  it('is a subset of the shared Zod request schema', () => {
    expect(createRewardRequestSchema.safeParse(validBody()).success).toBe(true);
    expect(createRewardRequestSchema.safeParse(validBody({ tenantId: 999 })).success).toBe(false);
  });
});
