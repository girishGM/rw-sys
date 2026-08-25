/**
 * T-034 — `CreateTenantAdminDto`: `POST /tenants/:id/admins`, and the nested `admin` field of
 * `POST /tenants`. Deliberately two fields and no more (`create-tenant-admin.dto.ts`'s own
 * header) — this suite proves that shape as much as it proves the two fields validate.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTenantAdminDto } from '@/modules/tenants/dto/create-tenant-admin.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(CreateTenantAdminDto, body));
  return Object.fromEntries(
    errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]),
  );
}

describe('CreateTenantAdminDto', () => {
  it('accepts a valid body', async () => {
    await expect(
      failures({ email: 'admin@example.invalid', displayName: 'Tenant Admin' }),
    ).resolves.toEqual({});
  });

  it('rejects a malformed email', async () => {
    const result = await failures({ email: 'not-an-email', displayName: 'X' });
    expect(result.email).toContain('isEmail');
  });

  it('rejects an empty display name', async () => {
    const result = await failures({ email: 'admin@example.invalid', displayName: '' });
    expect(result.displayName).toContain('minLength');
  });

  it('rejects an over-width email or display name', async () => {
    const longEmail = `${'a'.repeat(195)}@example.invalid`; // > 200 chars total
    const result = await failures({ email: longEmail, displayName: 'x'.repeat(101) });
    expect(result.email).toContain('maxLength');
    expect(result.displayName).toContain('maxLength');
  });

  it('has no password, role or tenantId field — server-generated / scope-derived only', () => {
    const fields = Object.getOwnPropertyNames(new CreateTenantAdminDto());
    expect(fields).not.toContain('password');
    expect(fields).not.toContain('role');
    expect(fields).not.toContain('tenantId');
  });
});
