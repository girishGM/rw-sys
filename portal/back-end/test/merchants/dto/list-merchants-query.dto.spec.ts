/**
 * T-036 — `ListMerchantsQueryDto`: `GET /merchants` (TC-21).
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListMerchantsQueryDto } from '@/modules/merchants/dto/list-merchants-query.dto';

async function failures(query: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(ListMerchantsQueryDto, query));
  return Object.fromEntries(
    errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]),
  );
}

describe('ListMerchantsQueryDto', () => {
  it('accepts an empty query', async () => {
    await expect(failures({})).resolves.toEqual({});
  });

  it('accepts every field populated', async () => {
    await expect(
      failures({ page: '2', pageSize: '50', sort: 'merchantCode:asc', search: 'acme' }),
    ).resolves.toEqual({});
  });

  it('accepts a large pageSize — capped by the service, not rejected here', async () => {
    await expect(failures({ pageSize: '500' })).resolves.toEqual({});
  });

  it('rejects page/pageSize below 1', async () => {
    expect((await failures({ page: '0' })).page).toContain('min');
    expect((await failures({ pageSize: '0' })).pageSize).toContain('min');
  });

  it('rejects an unknown sort field:direction pair', async () => {
    const result = await failures({ sort: 'unknownField:asc' });
    expect(result.sort).toContain('isIn');
  });

  it('accepts every documented sort field, both directions', async () => {
    for (const field of ['merchantCode', 'name', 'createdAt', 'status']) {
      for (const direction of ['asc', 'desc']) {
        await expect(failures({ sort: `${field}:${direction}` })).resolves.toEqual({});
      }
    }
  });

  it('rejects an over-length search string', async () => {
    const result = await failures({ search: 'x'.repeat(101) });
    expect(result.search).toContain('maxLength');
  });
});
