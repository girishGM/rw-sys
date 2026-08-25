import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListDefinitionRequestsQueryDto } from '@/modules/definition-requests/dto/list-definition-requests-query.dto';

describe('ListDefinitionRequestsQueryDto', () => {
  it('accepts an empty query', async () => {
    const errors = await validate(plainToInstance(ListDefinitionRequestsQueryDto, {}));
    expect(errors).toHaveLength(0);
  });

  it('accepts status and priority filters (TC-21)', async () => {
    const errors = await validate(
      plainToInstance(ListDefinitionRequestsQueryDto, { status: 'submitted', priority: 'high' }),
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects an unknown status', async () => {
    const errors = await validate(
      plainToInstance(ListDefinitionRequestsQueryDto, { status: 'invalid' }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an unknown priority', async () => {
    const errors = await validate(
      plainToInstance(ListDefinitionRequestsQueryDto, { priority: 'invalid' }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it('has no countryId/tenantId filter at all (R3)', () => {
    const instance = new ListDefinitionRequestsQueryDto();
    expect(Object.keys(instance)).not.toContain('countryId');
    expect(Object.keys(instance)).not.toContain('tenantId');
  });
});
