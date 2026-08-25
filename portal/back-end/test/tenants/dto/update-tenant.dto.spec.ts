/**
 * T-034 — `UpdateTenantDto`: `PATCH /tenants/:id`. Every field optional; the whitelist itself
 * (no `code`, no `countryId`) is the property under test as much as any single field's shape.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateTenantDto } from '@/modules/tenants/dto/update-tenant.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(UpdateTenantDto, body));
  return Object.fromEntries(
    errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]),
  );
}

describe('UpdateTenantDto', () => {
  it('accepts an empty body — every field optional', async () => {
    await expect(failures({})).resolves.toEqual({});
  });

  it('accepts every field populated, including every ck_tenants_status value', async () => {
    for (const status of ['pending_provisioning', 'active', 'inactive', 'suspended']) {
      await expect(
        failures({
          name: 'New Name',
          schemaPrefix: 'acme',
          contactEmail: 'ops@acme.example',
          contactPhone: '+60123456789',
          status,
        }),
      ).resolves.toEqual({});
    }
  });

  it('rejects an unknown status', async () => {
    const result = await failures({ status: 'deleted' });
    expect(result.status).toContain('isIn');
  });

  it('rejects a malformed schemaPrefix', async () => {
    const result = await failures({ schemaPrefix: 'BAD!' });
    expect(result.schemaPrefix).toContain('isTenantSchemaPrefix');
  });

  it('has no code or countryId field — immutable business key / scope-derived only', () => {
    const fields = Object.getOwnPropertyNames(new UpdateTenantDto());
    expect(fields).not.toContain('code');
    expect(fields).not.toContain('countryId');
  });

  it('rejects `code` or `id` under the whitelist (mirrors TC-17 of T-030)', async () => {
    const errors = await validate(plainToInstance(UpdateTenantDto, { code: 'X', id: 999 }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['code']).toHaveProperty('whitelistValidation');
    expect(flat['id']).toHaveProperty('whitelistValidation');
  });
});
