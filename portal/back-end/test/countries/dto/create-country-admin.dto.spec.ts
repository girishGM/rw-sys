/**
 * T-030 — `CreateCountryAdminDto`: `POST /countries/:id/admins`, and the nested `admin` field of
 * `POST /countries`. Two fields, deliberately: no `password` (BACKLOG.md B-01 — the server
 * generates it), no `role`/`countryId` (AGENT-PROTOCOL R3).
 */
import { getMetadataStorage, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { createCountryAdminRequestSchema } from '@reward-portal/shared';
import { CreateCountryAdminDto } from '@/modules/countries/dto/create-country-admin.dto';

function declaredProperties(): string[] {
  const metadata = getMetadataStorage().getTargetValidationMetadatas(
    CreateCountryAdminDto,
    '',
    false,
    false,
    undefined,
  );
  return [...new Set(metadata.map((entry) => entry.propertyName))].sort();
}

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(CreateCountryAdminDto, body));
  return Object.fromEntries(
    errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]),
  );
}

describe('CreateCountryAdminDto', () => {
  it('declares exactly email and displayName — no password, role or scope field', () => {
    expect(declaredProperties()).toEqual(['displayName', 'email']);
  });

  it('names the same fields as the shared Zod schema', () => {
    expect(Object.keys(createCountryAdminRequestSchema.shape).sort()).toEqual(declaredProperties());
  });

  it('accepts a valid body', async () => {
    await expect(
      failures({ email: 'admin@example.invalid', displayName: 'Country Admin' }),
    ).resolves.toEqual({});
  });

  it('rejects a non-email address', async () => {
    const result = await failures({ email: 'not-an-email', displayName: 'X' });
    expect(result.email).toContain('isEmail');
  });

  it('rejects an empty displayName', async () => {
    const result = await failures({ email: 'x@example.invalid', displayName: '' });
    expect(result.displayName).toContain('minLength');
  });

  it('rejects an email over the 200-character input bound', async () => {
    const result = await failures({
      email: `${'a'.repeat(195)}@example.invalid`,
      displayName: 'X',
    });
    expect(result.email).toContain('maxLength');
  });

  it('the shared schema rejects a client-supplied password or role', () => {
    expect(
      createCountryAdminRequestSchema.safeParse({
        email: 'x@example.invalid',
        displayName: 'X',
        password: 'whatever',
      }).success,
    ).toBe(false);
    expect(
      createCountryAdminRequestSchema.safeParse({
        email: 'x@example.invalid',
        displayName: 'X',
        role: 'super_admin',
      }).success,
    ).toBe(false);
  });
});
