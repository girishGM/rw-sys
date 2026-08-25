/**
 * T-035 — `ListUsersQueryDto`: `GET /users` query params.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListUsersQueryDto } from '@/modules/users/dto/list-users-query.dto';

async function isValid(query: Record<string, unknown>): Promise<boolean> {
  const errors = await validate(plainToInstance(ListUsersQueryDto, query));
  return errors.length === 0;
}

describe('ListUsersQueryDto', () => {
  it('accepts an empty query', async () => {
    await expect(isValid({})).resolves.toBe(true);
  });

  it('accepts page and pageSize as numeric strings, coerced', async () => {
    const instance = plainToInstance(ListUsersQueryDto, { page: '2', pageSize: '10' });
    expect(instance.page).toBe(2);
    expect(instance.pageSize).toBe(10);
  });

  it('rejects page/pageSize below 1', async () => {
    await expect(isValid({ page: 0 })).resolves.toBe(false);
    await expect(isValid({ pageSize: 0 })).resolves.toBe(false);
  });

  it.each(['displayName', 'email', 'role', 'status', 'createdAt'])(
    'accepts %s:asc and %s:desc as sort',
    async (field) => {
      await expect(isValid({ sort: `${field}:asc` })).resolves.toBe(true);
      await expect(isValid({ sort: `${field}:desc` })).resolves.toBe(true);
    },
  );

  it('rejects an unknown sort field or direction', async () => {
    await expect(isValid({ sort: 'passwordHash:asc' })).resolves.toBe(false);
    await expect(isValid({ sort: 'displayName:sideways' })).resolves.toBe(false);
  });
});
