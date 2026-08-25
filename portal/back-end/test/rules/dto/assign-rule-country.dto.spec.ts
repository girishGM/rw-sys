import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { assignRuleCountryRequestSchema } from '@reward-portal/shared';
import { AssignRuleCountryDto } from '@/modules/rules/dto/assign-rule-country.dto';

describe('AssignRuleCountryDto', () => {
  it('accepts a valid countryId', async () => {
    const errors = await validate(plainToInstance(AssignRuleCountryDto, { countryId: 1 }));
    expect(errors).toHaveLength(0);
  });

  it('rejects a missing countryId', async () => {
    const errors = await validate(plainToInstance(AssignRuleCountryDto, {}));
    expect(errors.some((error) => error.property === 'countryId')).toBe(true);
  });

  it('rejects a non-integer countryId', async () => {
    const errors = await validate(plainToInstance(AssignRuleCountryDto, { countryId: 'MY' }));
    expect(errors.some((error) => error.property === 'countryId')).toBe(true);
  });

  it('rejects assignedBy in the body (server derives it from the actor — implementation note 6, R3)', async () => {
    const errors = await validate(
      plainToInstance(AssignRuleCountryDto, { countryId: 1, assignedBy: 999 }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['assignedBy']).toHaveProperty('whitelistValidation');
  });

  it('is a subset of the shared Zod request schema', () => {
    expect(assignRuleCountryRequestSchema.safeParse({ countryId: 1 }).success).toBe(true);
    expect(assignRuleCountryRequestSchema.safeParse({}).success).toBe(false);
  });
});
