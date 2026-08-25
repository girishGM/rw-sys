import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateDefinitionRequestDto } from '@/modules/definition-requests/dto/create-definition-request.dto';

function valid(overrides: Record<string, unknown> = {}) {
  return {
    requestType: 'new_rule',
    title: 'Weekend multiplier',
    description: 'We need a 2x multiplier rule for weekends.',
    ...overrides,
  };
}

describe('CreateDefinitionRequestDto', () => {
  it('accepts a well-formed new_rule request', async () => {
    const errors = await validate(plainToInstance(CreateDefinitionRequestDto, valid()));
    expect(errors).toHaveLength(0);
  });

  it('accepts a well-formed update_reward request with entityId', async () => {
    const errors = await validate(
      plainToInstance(
        CreateDefinitionRequestDto,
        valid({ requestType: 'update_reward', entityId: 7 }),
      ),
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects an unknown requestType', async () => {
    const errors = await validate(
      plainToInstance(CreateDefinitionRequestDto, valid({ requestType: 'delete_rule' })),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a too-short title', async () => {
    const errors = await validate(
      plainToInstance(CreateDefinitionRequestDto, valid({ title: 'x' })),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a too-short description', async () => {
    const errors = await validate(
      plainToInstance(CreateDefinitionRequestDto, valid({ description: 'short' })),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a malformed desiredBy', async () => {
    const errors = await validate(
      plainToInstance(CreateDefinitionRequestDto, valid({ desiredBy: '2026/01/01' })),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a well-formed desiredBy and priority', async () => {
    const errors = await validate(
      plainToInstance(
        CreateDefinitionRequestDto,
        valid({ desiredBy: '2026-03-01', priority: 'urgent' }),
      ),
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects an unknown priority', async () => {
    const errors = await validate(
      plainToInstance(CreateDefinitionRequestDto, valid({ priority: 'critical' })),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});
