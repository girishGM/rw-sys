/**
 * T-035 — `CreateUserDto`: `POST /users`.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { flattenValidationErrors } from '@/common/errors/validation.exception-factory';
import { CreateUserDto } from '@/modules/users/dto/create-user.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(CreateUserDto, body));
  const flat: Record<string, string[]> = {};
  for (const detail of flattenValidationErrors(errors)) {
    flat[detail.field] = [...(flat[detail.field] ?? []), detail.code];
  }
  return flat;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: 'new.user@example.invalid',
    displayName: 'New User',
    role: 'maker',
    ...overrides,
  };
}

describe('CreateUserDto', () => {
  it('accepts a fully valid body with only the required fields', async () => {
    await expect(failures(validBody())).resolves.toEqual({});
  });

  it('accepts every scope id populated at once — the service decides which one is read', async () => {
    await expect(
      failures(validBody({ countryId: 1, tenantId: 2, merchantId: 3 })),
    ).resolves.toEqual({});
  });

  it('rejects a malformed email', async () => {
    expect((await failures(validBody({ email: 'not-an-email' }))).email).toContain('IS_EMAIL');
  });

  it('rejects an empty or over-width displayName', async () => {
    expect((await failures(validBody({ displayName: '' }))).displayName).toContain('MIN_LENGTH');
    expect((await failures(validBody({ displayName: 'x'.repeat(101) }))).displayName).toContain(
      'MAX_LENGTH',
    );
  });

  it('rejects a role outside the six-role union', async () => {
    const result = await failures(validBody({ role: 'god_mode' }));
    expect(result.role).toBeDefined();
  });

  it('rejects a non-integer scope id', async () => {
    expect((await failures(validBody({ countryId: 'one' }))).countryId).toBeDefined();
    expect((await failures(validBody({ tenantId: 'one' }))).tenantId).toBeDefined();
    expect((await failures(validBody({ merchantId: 'one' }))).merchantId).toBeDefined();
  });

  it('has no password field at all — BACKLOG.md B-01: the server generates it', () => {
    expect(Object.getOwnPropertyNames(new CreateUserDto())).not.toContain('password');
  });

  it('rejects an unexpected top-level field under the whitelist', async () => {
    const errors = await validate(
      plainToInstance(CreateUserDto, validBody({ passwordHash: 'x' })),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['passwordHash']).toHaveProperty('whitelistValidation');
  });
});
