import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  createRewardPolicyRequestSchema,
  updateRewardPolicyRequestSchema,
} from '@reward-portal/shared';
import {
  CreateRewardPolicyDto,
  UpdateRewardPolicyDto,
} from '@/modules/rewards/dto/reward-policy.dto';

describe('CreateRewardPolicyDto', () => {
  it('accepts a minimal valid body', async () => {
    const errors = await validate(
      plainToInstance(CreateRewardPolicyDto, { policyCode: 'STANDARD', name: 'Standard' }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects a lower-case policyCode', async () => {
    const errors = await validate(
      plainToInstance(CreateRewardPolicyDto, { policyCode: 'standard', name: 'x' }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors.some((error) => error.property === 'policyCode')).toBe(true);
  });

  it('accepts a config object', async () => {
    const errors = await validate(
      plainToInstance(CreateRewardPolicyDto, {
        policyCode: 'STANDARD',
        name: 'x',
        config: { tierMultiplier: 1.5 },
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors).toHaveLength(0);
  });

  it('matches the shared Zod request schema', () => {
    expect(
      createRewardPolicyRequestSchema.safeParse({ policyCode: 'STANDARD', name: 'Standard' })
        .success,
    ).toBe(true);
  });
});

describe('UpdateRewardPolicyDto', () => {
  it('rejects policyCode — immutable, never accepted here', async () => {
    const errors = await validate(plainToInstance(UpdateRewardPolicyDto, { policyCode: 'NEW' }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['policyCode']).toHaveProperty('whitelistValidation');
  });

  it('accepts a partial update', async () => {
    const errors = await validate(plainToInstance(UpdateRewardPolicyDto, { status: 'inactive' }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors).toHaveLength(0);
  });

  it('matches the shared Zod request schema', () => {
    expect(updateRewardPolicyRequestSchema.safeParse({ status: 'inactive' }).success).toBe(true);
  });
});
