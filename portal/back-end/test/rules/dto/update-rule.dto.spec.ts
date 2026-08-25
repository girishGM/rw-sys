import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { updateRuleRequestSchema } from '@reward-portal/shared';
import { flattenValidationErrors } from '@/common/errors/validation.exception-factory';
import { UpdateRuleDto } from '@/modules/rules/dto/update-rule.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(UpdateRuleDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const flat: Record<string, string[]> = {};
  for (const detail of flattenValidationErrors(errors)) {
    flat[detail.field] = [...(flat[detail.field] ?? []), detail.code];
  }
  return flat;
}

describe('UpdateRuleDto', () => {
  it('accepts an empty body — every field optional', async () => {
    await expect(failures({})).resolves.toEqual({});
  });

  it('accepts a partial update', async () => {
    await expect(failures({ name: 'New name' })).resolves.toEqual({});
    await expect(failures({ status: 'inactive' })).resolves.toEqual({});
    await expect(failures({ expression: null })).resolves.toEqual({});
  });

  it('rejects an unknown status', async () => {
    const result = await failures({ status: 'archived' });
    expect(result.status).toContain('IS_IN');
  });

  it('rejects malformed parameters', async () => {
    const result = await failures({
      parameters: { fields: [{ key: 'bad key', label: 'x', type: 'string', required: true }] },
    });
    expect(result.parameters).toContain('IS_RULE_PARAMETERS');
  });

  it('has no ruleCode property at all — immutable (never accepted, whitelisted or not)', async () => {
    const errors = await validate(plainToInstance(UpdateRuleDto, { ruleCode: 'NEW_CODE' }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['ruleCode']).toHaveProperty('whitelistValidation');
  });

  it('rejects a client-supplied tenantId (R3)', async () => {
    const errors = await validate(plainToInstance(UpdateRuleDto, { tenantId: 999 }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['tenantId']).toHaveProperty('whitelistValidation');
  });

  it('is a subset of the shared Zod request schema', () => {
    expect(updateRuleRequestSchema.safeParse({}).success).toBe(true);
    expect(updateRuleRequestSchema.safeParse({ status: 'inactive' }).success).toBe(true);
    expect(updateRuleRequestSchema.safeParse({ ruleCode: 'X' }).success).toBe(false);
  });
});
