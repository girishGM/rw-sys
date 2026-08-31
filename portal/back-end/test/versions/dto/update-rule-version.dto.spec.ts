import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateRuleVersionDto } from '@/modules/versions/dto/update-rule-version.dto';

describe('UpdateRuleVersionDto', () => {
  it('accepts an empty body — every field optional', async () => {
    const errors = await validate(plainToInstance(UpdateRuleVersionDto, {}));
    expect(errors).toHaveLength(0);
  });

  it('accepts expression, parameters, changeSummary, isBreaking and confirmBreakingOverride', async () => {
    const errors = await validate(
      plainToInstance(UpdateRuleVersionDto, {
        expression: 'a >= 1',
        parameters: { fields: [] },
        changeSummary: 'bump the threshold',
        isBreaking: true,
        confirmBreakingOverride: true,
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts a null expression/changeSummary (clearing them)', async () => {
    const errors = await validate(
      plainToInstance(UpdateRuleVersionDto, { expression: null, changeSummary: null }),
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects a non-boolean isBreaking', async () => {
    const errors = await validate(plainToInstance(UpdateRuleVersionDto, { isBreaking: 'yes' }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an over-long expression', async () => {
    const errors = await validate(
      plainToInstance(UpdateRuleVersionDto, { expression: 'x'.repeat(8001) }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  // T-109
  it('accepts resolverId, resolverConfig, evaluationContext and defaultOperators', async () => {
    const errors = await validate(
      plainToInstance(UpdateRuleVersionDto, {
        resolverId: 5,
        resolverConfig: { path: 'transaction.amount' },
        evaluationContext: 'transaction_payload',
        defaultOperators: ['equals', 'in'],
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts null for all 4 resolver-wiring fields — clearing must stay possible', async () => {
    const errors = await validate(
      plainToInstance(UpdateRuleVersionDto, {
        resolverId: null,
        resolverConfig: null,
        evaluationContext: null,
        defaultOperators: null,
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects a non-integer resolverId', async () => {
    const errors = await validate(plainToInstance(UpdateRuleVersionDto, { resolverId: 'five' }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-array defaultOperators', async () => {
    const errors = await validate(
      plainToInstance(UpdateRuleVersionDto, { defaultOperators: 'equals' }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a defaultOperators entry that is not a string', async () => {
    const errors = await validate(
      plainToInstance(UpdateRuleVersionDto, { defaultOperators: ['equals', 42] }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an over-long evaluationContext', async () => {
    const errors = await validate(
      plainToInstance(UpdateRuleVersionDto, { evaluationContext: 'x'.repeat(51) }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-object resolverConfig', async () => {
    const errors = await validate(
      plainToInstance(UpdateRuleVersionDto, { resolverConfig: 'not-an-object' }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});
