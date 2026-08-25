import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateRewardVersionDto } from '@/modules/versions/dto/update-reward-version.dto';

describe('UpdateRewardVersionDto', () => {
  it('accepts an empty body — every field optional', async () => {
    const errors = await validate(plainToInstance(UpdateRewardVersionDto, {}));
    expect(errors).toHaveLength(0);
  });

  it('accepts every field, including a valid unitType', async () => {
    const errors = await validate(
      plainToInstance(UpdateRewardVersionDto, {
        connectorConfig: { apiKey: 'x' },
        deliveryMode: 'batch',
        retryConfig: { maxAttempts: 3 },
        policiesSnapshot: [{ policyCode: 'P1' }],
        unitType: 'points',
        unitCode: 'PTS',
        changeSummary: 'switch to batch delivery',
        isBreaking: false,
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects an unrecognised unitType', async () => {
    const errors = await validate(plainToInstance(UpdateRewardVersionDto, { unitType: 'bitcoin' }));
    expect(errors.length).toBeGreaterThan(0);
  });
});
