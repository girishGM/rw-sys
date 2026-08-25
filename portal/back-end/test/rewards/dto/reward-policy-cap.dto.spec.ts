import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  createRewardPolicyCapRequestSchema,
  updateRewardPolicyCapRequestSchema,
} from '@reward-portal/shared';
import {
  CreateRewardPolicyCapDto,
  UpdateRewardPolicyCapDto,
} from '@/modules/rewards/dto/reward-policy-cap.dto';

describe('CreateRewardPolicyCapDto', () => {
  it('accepts a minimal valid body', async () => {
    const errors = await validate(
      plainToInstance(CreateRewardPolicyCapDto, { capType: 'per_customer' }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts a fully-specified cap', async () => {
    const errors = await validate(
      plainToInstance(CreateRewardPolicyCapDto, {
        capType: 'daily',
        frequencyValue: 1,
        frequencyUnit: 'day',
        maxOccurrences: 3,
        maxTotalAmount: 50,
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects an unrecognised capType', async () => {
    const errors = await validate(
      plainToInstance(CreateRewardPolicyCapDto, { capType: 'made_up' }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors.some((error) => error.property === 'capType')).toBe(true);
  });

  it('rejects a non-positive frequencyValue', async () => {
    const errors = await validate(
      plainToInstance(CreateRewardPolicyCapDto, { capType: 'daily', frequencyValue: -1 }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors.some((error) => error.property === 'frequencyValue')).toBe(true);
  });

  it('matches the shared Zod request schema', () => {
    expect(createRewardPolicyCapRequestSchema.safeParse({ capType: 'per_customer' }).success).toBe(
      true,
    );
  });
});

describe('UpdateRewardPolicyCapDto', () => {
  it('accepts a partial update', async () => {
    const errors = await validate(
      plainToInstance(UpdateRewardPolicyCapDto, { status: 'inactive' }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors).toHaveLength(0);
  });

  it('matches the shared Zod request schema', () => {
    expect(updateRewardPolicyCapRequestSchema.safeParse({ status: 'inactive' }).success).toBe(true);
  });
});
