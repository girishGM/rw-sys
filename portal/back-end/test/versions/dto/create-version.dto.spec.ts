import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateVersionDto } from '@/modules/versions/dto/create-version.dto';

describe('CreateVersionDto', () => {
  it('accepts an empty body', async () => {
    const errors = await validate(plainToInstance(CreateVersionDto, {}));
    expect(errors).toHaveLength(0);
  });

  it('accepts changeSummary and originRequestId', async () => {
    const errors = await validate(
      plainToInstance(CreateVersionDto, { changeSummary: 'requested by MY', originRequestId: 4 }),
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects an over-long changeSummary', async () => {
    const errors = await validate(
      plainToInstance(CreateVersionDto, { changeSummary: 'x'.repeat(501) }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});
