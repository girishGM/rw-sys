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
});
