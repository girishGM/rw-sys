import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListRulesQueryDto } from '@/modules/rules/dto/list-rules-query.dto';

async function errorsFor(query: Record<string, unknown>) {
  return validate(plainToInstance(ListRulesQueryDto, query, { enableImplicitConversion: false }), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('ListRulesQueryDto', () => {
  it('accepts an empty query', async () => {
    expect(await errorsFor({})).toHaveLength(0);
  });

  it('accepts page, pageSize, status and sort', async () => {
    const errors = await errorsFor({
      page: '2',
      pageSize: '50',
      status: 'active',
      sort: 'createdAt:desc',
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects page < 1', async () => {
    const errors = await errorsFor({ page: '0' });
    expect(errors.some((error) => error.property === 'page')).toBe(true);
  });

  it('rejects an unknown status', async () => {
    const errors = await errorsFor({ status: 'archived' });
    expect(errors.some((error) => error.property === 'status')).toBe(true);
  });

  it('rejects a sort field not in the whitelist', async () => {
    const errors = await errorsFor({ sort: 'expression:asc' });
    expect(errors.some((error) => error.property === 'sort')).toBe(true);
  });

  it('rejects a countryId filter — visibility comes from the actor’s own scope only (R3)', async () => {
    const errors = await errorsFor({ countryId: '1' });
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['countryId']).toHaveProperty('whitelistValidation');
  });
});
