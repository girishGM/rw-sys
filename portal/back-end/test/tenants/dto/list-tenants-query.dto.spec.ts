/**
 * T-034 — `ListTenantsQueryDto`: `GET /tenants` query params.
 */
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ListTenantsQueryDto } from '@/modules/tenants/dto/list-tenants-query.dto';

async function failures(query: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(ListTenantsQueryDto, query));
  return Object.fromEntries(
    errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]),
  );
}

describe('ListTenantsQueryDto', () => {
  it('accepts no query params at all', async () => {
    await expect(failures({})).resolves.toEqual({});
  });

  it('accepts page, pageSize and a whitelisted sort', async () => {
    await expect(failures({ page: '2', pageSize: '50', sort: 'status:asc' })).resolves.toEqual({});
  });

  it('rejects page < 1', async () => {
    const result = await failures({ page: '0' });
    expect(result.page).toContain('min');
  });

  it('rejects a non-integer page', async () => {
    const result = await failures({ page: '1.5' });
    expect(result.page).toContain('isInt');
  });

  it('does NOT reject an oversized pageSize (the service caps it)', async () => {
    await expect(failures({ pageSize: '99999' })).resolves.toEqual({});
  });

  it('rejects an arbitrary sort string — no generic query DSL from the client', async () => {
    const result = await failures({ sort: 'schemaPrefix:asc' });
    expect(result.sort).toContain('isIn');
  });
});
