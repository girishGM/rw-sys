import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReviewDefinitionRequestDto } from '@/modules/definition-requests/dto/review-definition-request.dto';

describe('ReviewDefinitionRequestDto', () => {
  it('accepts status alone', async () => {
    const errors = await validate(
      plainToInstance(ReviewDefinitionRequestDto, { status: 'under_review' }),
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts status with a reviewComment', async () => {
    const errors = await validate(
      plainToInstance(ReviewDefinitionRequestDto, {
        status: 'rejected',
        reviewComment: 'Not enough detail',
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects a missing status', async () => {
    const errors = await validate(plainToInstance(ReviewDefinitionRequestDto, {}));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects "submitted"/"withdrawn"/"fulfilled" — not reachable via .../review', async () => {
    for (const status of ['submitted', 'withdrawn', 'fulfilled']) {
      const errors = await validate(plainToInstance(ReviewDefinitionRequestDto, { status }));
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects an over-long reviewComment', async () => {
    const errors = await validate(
      plainToInstance(ReviewDefinitionRequestDto, {
        status: 'rejected',
        reviewComment: 'x'.repeat(1001),
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});
