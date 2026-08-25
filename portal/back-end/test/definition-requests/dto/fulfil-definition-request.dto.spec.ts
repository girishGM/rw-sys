import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FulfilDefinitionRequestDto } from '@/modules/definition-requests/dto/fulfil-definition-request.dto';

describe('FulfilDefinitionRequestDto', () => {
  it('accepts a well-formed versionId', async () => {
    const errors = await validate(plainToInstance(FulfilDefinitionRequestDto, { versionId: 10 }));
    expect(errors).toHaveLength(0);
  });

  it('rejects a missing versionId', async () => {
    const errors = await validate(plainToInstance(FulfilDefinitionRequestDto, {}));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-integer versionId', async () => {
    const errors = await validate(
      plainToInstance(FulfilDefinitionRequestDto, { versionId: 'ten' }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});
