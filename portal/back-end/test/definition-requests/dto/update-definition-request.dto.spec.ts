import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateDefinitionRequestDto } from '@/modules/definition-requests/dto/update-definition-request.dto';

describe('UpdateDefinitionRequestDto', () => {
  it('accepts an empty body', async () => {
    const errors = await validate(plainToInstance(UpdateDefinitionRequestDto, {}));
    expect(errors).toHaveLength(0);
  });

  it('accepts a partial update', async () => {
    const errors = await validate(
      plainToInstance(UpdateDefinitionRequestDto, { title: 'A better title', priority: 'high' }),
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects an unknown priority', async () => {
    const errors = await validate(
      plainToInstance(UpdateDefinitionRequestDto, { priority: 'critical' }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a too-short description when supplied', async () => {
    const errors = await validate(
      plainToInstance(UpdateDefinitionRequestDto, { description: 'short' }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});
