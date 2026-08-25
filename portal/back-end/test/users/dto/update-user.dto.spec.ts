/**
 * T-035 — `UpdateUserDto`: `PATCH /users/:id`.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { flattenValidationErrors } from '@/common/errors/validation.exception-factory';
import { UpdateUserDto } from '@/modules/users/dto/update-user.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(UpdateUserDto, body));
  const flat: Record<string, string[]> = {};
  for (const detail of flattenValidationErrors(errors)) {
    flat[detail.field] = [...(flat[detail.field] ?? []), detail.code];
  }
  return flat;
}

describe('UpdateUserDto', () => {
  it('accepts an empty body — every field is optional', async () => {
    await expect(failures({})).resolves.toEqual({});
  });

  it('accepts a displayName change', async () => {
    await expect(failures({ displayName: 'Renamed' })).resolves.toEqual({});
  });

  it('rejects an empty or over-width displayName', async () => {
    expect((await failures({ displayName: '' })).displayName).toContain('MIN_LENGTH');
    expect((await failures({ displayName: 'x'.repeat(101) })).displayName).toContain('MAX_LENGTH');
  });

  it('shape-validates a role field (TC-28) — passes shape validation so the service, not the pipe, refuses it', async () => {
    await expect(failures({ role: 'tenant_admin' })).resolves.toEqual({});
  });

  it('rejects a role outside the six-role union at the shape layer', async () => {
    const result = await failures({ role: 'god_mode' });
    expect(result.role).toBeDefined();
  });

  it('has no email or scope-id field — an identity/scope change is out of this route entirely', () => {
    const own = Object.getOwnPropertyNames(new UpdateUserDto());
    expect(own).not.toContain('email');
    expect(own).not.toContain('countryId');
    expect(own).not.toContain('tenantId');
    expect(own).not.toContain('merchantId');
  });

  it('rejects an unexpected top-level field under the whitelist', async () => {
    const errors = await validate(
      plainToInstance(UpdateUserDto, { email: 'new@example.invalid' }),
      {
        whitelist: true,
        forbidNonWhitelisted: true,
      },
    );
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['email']).toHaveProperty('whitelistValidation');
  });
});
