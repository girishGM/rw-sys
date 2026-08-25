import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createRuleRequestSchema } from '@reward-portal/shared';
import { flattenValidationErrors } from '@/common/errors/validation.exception-factory';
import { CreateRuleDto } from '@/modules/rules/dto/create-rule.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(CreateRuleDto, body), {
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
    ruleCode: 'MIN_SPEND_TIER',
    name: 'Minimum spend tier',
    subCategoryId: 13,
    ...overrides,
  };
}

describe('CreateRuleDto', () => {
  it('accepts a minimal valid body', async () => {
    await expect(failures(validBody())).resolves.toEqual({});
  });

  it('accepts expression and parameters', async () => {
    await expect(
      failures(
        validBody({
          expression: 'amount >= :minSpend',
          parameters: {
            fields: [{ key: 'minSpend', label: 'Minimum spend', type: 'number', required: true }],
          },
        }),
      ),
    ).resolves.toEqual({});
  });

  it('rejects a lower-case ruleCode', async () => {
    const result = await failures(validBody({ ruleCode: 'min_spend' }));
    expect(result.ruleCode).toContain('IS_RULE_CODE');
  });

  it('rejects a ruleCode over the varchar(80) column width', async () => {
    const result = await failures(validBody({ ruleCode: 'A'.repeat(81) }));
    expect(result.ruleCode).toContain('MAX_LENGTH');
  });

  it('rejects an empty name', async () => {
    const result = await failures(validBody({ name: '' }));
    expect(result.name).toContain('MIN_LENGTH');
  });

  it('rejects a non-integer subCategoryId', async () => {
    const result = await failures(validBody({ subCategoryId: 'thirteen' }));
    expect(result.subCategoryId).toContain('IS_INT');
  });

  it('rejects malformed parameters (TC-14)', async () => {
    const result = await failures(
      validBody({
        parameters: { fields: [{ key: 'bad key!', label: 'x', type: 'string', required: true }] },
      }),
    );
    expect(result.parameters).toContain('IS_RULE_PARAMETERS');
  });

  it('rejects an unexpected top-level field under the whitelist (R3 — no client-supplied tenantId)', async () => {
    const errors = await validate(plainToInstance(CreateRuleDto, validBody({ tenantId: 999 })), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['tenantId']).toHaveProperty('whitelistValidation');
  });

  it('rejects a client-supplied status (server always writes active on create)', async () => {
    const errors = await validate(
      plainToInstance(CreateRuleDto, validBody({ status: 'inactive' })),
      {
        whitelist: true,
        forbidNonWhitelisted: true,
      },
    );
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['status']).toHaveProperty('whitelistValidation');
  });

  it('is a subset of the shared Zod request schema', () => {
    expect(createRuleRequestSchema.safeParse(validBody()).success).toBe(true);
    expect(createRuleRequestSchema.safeParse(validBody({ tenantId: 999 })).success).toBe(false);
  });
});
