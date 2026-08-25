/**
 * T-036 — `CreateMerchantDto`: `POST /merchants`.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { flattenValidationErrors } from '@/common/errors/validation.exception-factory';
import { CreateMerchantDto } from '@/modules/merchants/dto/create-merchant.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(CreateMerchantDto, body));
  const flat: Record<string, string[]> = {};
  for (const detail of flattenValidationErrors(errors)) {
    flat[detail.field] = [...(flat[detail.field] ?? []), detail.code];
  }
  return flat;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { merchantCode: 'M001', name: 'Acme Store', countryCode: 'MY', ...overrides };
}

describe('CreateMerchantDto', () => {
  it('accepts a fully valid body with only the required fields', async () => {
    await expect(failures(validBody())).resolves.toEqual({});
  });

  it('accepts every optional field populated', async () => {
    await expect(
      failures(
        validBody({
          description: 'A great merchant',
          contactEmail: 'ops@acme.example',
          contactPhone: '+60123456789',
          website: 'https://acme.example',
        }),
      ),
    ).resolves.toEqual({});
  });

  it('has no tenantId field at all — AGENT-PROTOCOL R3', () => {
    expect(Object.getOwnPropertyNames(new CreateMerchantDto())).not.toContain('tenantId');
  });

  it('upper-cases countryCode before validation', () => {
    const instance = plainToInstance(CreateMerchantDto, validBody({ countryCode: 'my' }));
    expect(instance.countryCode).toBe('MY');
  });

  it('leaves a non-string countryCode untouched for @IsString to reject on its own terms', () => {
    const instance = plainToInstance(CreateMerchantDto, validBody({ countryCode: 42 }));
    expect(instance.countryCode).toBe(42);
  });

  it('rejects an empty or over-width merchantCode', async () => {
    expect((await failures(validBody({ merchantCode: '' }))).merchantCode).toBeDefined();
    expect(
      (await failures(validBody({ merchantCode: 'x'.repeat(51) }))).merchantCode,
    ).toBeDefined();
  });

  it('rejects a merchantCode with characters outside [A-Za-z0-9_-]', async () => {
    const result = await failures(validBody({ merchantCode: 'M 001!' }));
    expect(result.merchantCode).toBeDefined();
  });

  it('rejects an empty or over-width name', async () => {
    expect((await failures(validBody({ name: '' }))).name).toContain('MIN_LENGTH');
    expect((await failures(validBody({ name: 'x'.repeat(201) }))).name).toContain('MAX_LENGTH');
  });

  it('rejects a countryCode that is not exactly 2 letters', async () => {
    expect((await failures(validBody({ countryCode: 'M' }))).countryCode).toBeDefined();
    expect((await failures(validBody({ countryCode: 'MYS' }))).countryCode).toBeDefined();
    expect((await failures(validBody({ countryCode: '12' }))).countryCode).toBeDefined();
  });

  it('rejects a malformed contact email or phone', async () => {
    expect((await failures(validBody({ contactEmail: 'not-an-email' }))).contactEmail).toContain(
      'IS_EMAIL',
    );
    expect((await failures(validBody({ contactPhone: 'abc' }))).contactPhone).toBeDefined();
  });

  it('rejects an unexpected top-level field under the whitelist', async () => {
    const errors = await validate(
      plainToInstance(CreateMerchantDto, validBody({ tenantId: 999 })),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['tenantId']).toHaveProperty('whitelistValidation');
  });
});
