/**
 * T-034 — `CreateTenantDto`: `POST /tenants`.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { flattenValidationErrors } from '@/common/errors/validation.exception-factory';
import { CreateTenantDto } from '@/modules/tenants/dto/create-tenant.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(CreateTenantDto, body));
  const flat: Record<string, string[]> = {};
  for (const detail of flattenValidationErrors(errors)) {
    flat[detail.field] = [...(flat[detail.field] ?? []), detail.code];
  }
  return flat;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { code: 'T001', name: 'Acme Retail', ...overrides };
}

describe('CreateTenantDto', () => {
  it('accepts a fully valid body with only the required fields', async () => {
    await expect(failures(validBody())).resolves.toEqual({});
  });

  it('accepts every optional field populated', async () => {
    await expect(
      failures(
        validBody({
          schemaPrefix: 'acme',
          contactEmail: 'ops@acme.example',
          contactPhone: '+60123456789',
        }),
      ),
    ).resolves.toEqual({});
  });

  it('has no countryId field at all — implementation note 2 / AGENT-PROTOCOL R3', () => {
    expect(Object.getOwnPropertyNames(new CreateTenantDto())).not.toContain('countryId');
  });

  it('upper-cases code before validation', () => {
    const instance = plainToInstance(CreateTenantDto, validBody({ code: 't001' }));
    expect(instance.code).toBe('T001');
  });

  it('leaves a non-string code untouched for @IsString to reject on its own terms', () => {
    const instance = plainToInstance(CreateTenantDto, validBody({ code: 42 }));
    expect(instance.code).toBe(42);
  });

  it('rejects an empty or over-width code', async () => {
    expect((await failures(validBody({ code: '' }))).code).toBeDefined();
    expect((await failures(validBody({ code: 'x'.repeat(21) }))).code).toBeDefined();
  });

  it('rejects a code with characters outside [A-Z0-9_-]', async () => {
    const result = await failures(validBody({ code: 'T 001!' }));
    expect(result.code).toBeDefined();
  });

  it('rejects an empty or over-width name', async () => {
    expect((await failures(validBody({ name: '' }))).name).toContain('MIN_LENGTH');
    expect((await failures(validBody({ name: 'x'.repeat(101) }))).name).toContain('MAX_LENGTH');
  });

  it('validates schemaPrefix against implementation note 4 (TC-12)', async () => {
    const result = await failures(validBody({ schemaPrefix: 'Bad-Prefix!' }));
    expect(result.schemaPrefix).toContain('IS_TENANT_SCHEMA_PREFIX');
  });

  it('accepts an omitted schemaPrefix — it may be null (implementation note 4)', async () => {
    await expect(failures(validBody())).resolves.toEqual({});
  });

  it('rejects a malformed contact email or phone', async () => {
    expect((await failures(validBody({ contactEmail: 'not-an-email' }))).contactEmail).toContain(
      'IS_EMAIL',
    );
    expect((await failures(validBody({ contactPhone: 'abc' }))).contactPhone).toBeDefined();
  });

  it('rejects an unexpected top-level field under the whitelist', async () => {
    const errors = await validate(plainToInstance(CreateTenantDto, validBody({ countryId: 999 })), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['countryId']).toHaveProperty('whitelistValidation');
  });

  it('validates a nested admin object (TC-13)', async () => {
    const result = await failures(validBody({ admin: { email: 'not-an-email', displayName: '' } }));
    expect(result['admin.email']).toContain('IS_EMAIL');
    expect(result['admin.displayName']).toContain('MIN_LENGTH');
  });

  it('accepts a valid nested admin object', async () => {
    await expect(
      failures(validBody({ admin: { email: 'admin@example.invalid', displayName: 'Admin' } })),
    ).resolves.toEqual({});
  });
});
