import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { assignRewardCountryRequestSchema } from '@reward-portal/shared';
import { AssignRewardCountryDto } from '@/modules/rewards/dto/assign-reward-country.dto';

describe('AssignRewardCountryDto', () => {
  it('accepts a valid countryId', async () => {
    const errors = await validate(plainToInstance(AssignRewardCountryDto, { countryId: 2 }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects a non-integer countryId', async () => {
    const errors = await validate(plainToInstance(AssignRewardCountryDto, { countryId: 'two' }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.some((error) => error.property === 'countryId')).toBe(true);
  });

  it('rejects a client-supplied assignedBy (R3)', async () => {
    const errors = await validate(
      plainToInstance(AssignRewardCountryDto, { countryId: 2, assignedBy: 99 }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['assignedBy']).toHaveProperty('whitelistValidation');
  });

  it('matches the shared Zod request schema', () => {
    expect(assignRewardCountryRequestSchema.safeParse({ countryId: 2 }).success).toBe(true);
  });
});
