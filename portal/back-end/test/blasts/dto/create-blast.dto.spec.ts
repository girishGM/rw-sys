import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { flattenValidationErrors } from '@/common/errors/validation.exception-factory';
import { CreateBlastDto } from '@/modules/blasts/dto/create-blast.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(CreateBlastDto, body), {
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
    entityType: 'rule',
    entityId: 1,
    versionId: 10,
    scope: 'selected',
    countryIds: [2, 3],
    ...overrides,
  };
}

describe('CreateBlastDto', () => {
  it('accepts a minimal valid selected-scope body', async () => {
    await expect(failures(validBody())).resolves.toEqual({});
  });

  it('accepts an all_countries body with no countryIds', async () => {
    const body = validBody({ scope: 'all_countries' });
    delete body['countryIds'];
    await expect(failures(body)).resolves.toEqual({});
  });

  it('accepts note, originRequestId and confirmBreaking', async () => {
    await expect(
      failures(validBody({ note: 'weekend promo', originRequestId: 7, confirmBreaking: true })),
    ).resolves.toEqual({});
  });

  it('rejects an entityType outside rule/reward', async () => {
    const result = await failures(validBody({ entityType: 'campaign' }));
    expect(result.entityType).toBeDefined();
  });

  it('rejects a scope outside all_countries/selected', async () => {
    const result = await failures(validBody({ scope: 'everywhere' }));
    expect(result.scope).toBeDefined();
  });

  it('rejects a non-numeric countryIds entry', async () => {
    const result = await failures(validBody({ countryIds: [2, 'MY'] }));
    expect(result.countryIds).toBeDefined();
  });

  it('rejects an unknown field (forbidNonWhitelisted)', async () => {
    const result = await failures(validBody({ tenantId: 7 }));
    expect(result.tenantId).toBeDefined();
  });

  it('rejects a missing versionId', async () => {
    const body = validBody();
    delete body['versionId'];
    const result = await failures(body);
    expect(result.versionId).toBeDefined();
  });
});
