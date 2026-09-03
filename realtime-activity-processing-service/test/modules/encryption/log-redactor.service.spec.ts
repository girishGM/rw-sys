/**
 * T-RAP-012. Unit tests against a stub `FieldEncryptionConfigRepository` — pure precedence-logic
 * coverage, no DB. The real repository's own DB round trip is covered separately in
 * `field-encryption-config.repository.spec.ts`.
 */
import type { FieldEncryptionConfigRow } from '@/database/models/field-encryption-config.model';
import { FieldEncryptionConfigRepository } from '@/modules/encryption/field-encryption-config.repository';
import { LogRedactorService } from '@/modules/encryption/log-redactor.service';

function row(
  overrides: Partial<FieldEncryptionConfigRow> &
    Pick<FieldEncryptionConfigRow, 'scope_level' | 'field_name'>,
): FieldEncryptionConfigRow {
  return {
    id: 'row-id',
    scope_ref: null,
    is_encrypted: true,
    added_at: new Date(),
    added_by: 'test',
    ...overrides,
  };
}

function stubRepository(rows: FieldEncryptionConfigRow[]): FieldEncryptionConfigRepository {
  return {
    findAll: jest.fn().mockResolvedValue(rows),
  } as unknown as FieldEncryptionConfigRepository;
}

// This is the exact fixture T-RAP-003 seeds in the real DB — mirrored here so this suite proves
// the *precedence logic*, not "does the real DB have a row", which the repository spec already
// covers.
const SEEDED_DEFAULT_ROWS: FieldEncryptionConfigRow[] = [
  row({ scope_level: 'global', scope_ref: null, field_name: 'customerId', is_encrypted: true }),
];

describe('LogRedactorService', () => {
  // TC-4
  it("resolve('customerId', {}) against the seeded default config returns true", async () => {
    const redactor = new LogRedactorService(stubRepository(SEEDED_DEFAULT_ROWS));
    await redactor.refresh();
    expect(redactor.resolve('customerId', {})).toBe(true);
  });

  // TC-5
  it("resolve('activityValue', {}) against the seeded default config returns false (not configured)", async () => {
    const redactor = new LogRedactorService(stubRepository(SEEDED_DEFAULT_ROWS));
    await redactor.refresh();
    expect(redactor.resolve('activityValue', {})).toBe(false);
  });

  // TC-6
  it('a campaign-scoped override resolves true in-context and false out-of-context', async () => {
    const rows: FieldEncryptionConfigRow[] = [
      ...SEEDED_DEFAULT_ROWS,
      row({
        scope_level: 'campaign',
        scope_ref: 'CAMP1',
        field_name: 'activityValue',
        is_encrypted: true,
      }),
    ];
    const redactor = new LogRedactorService(stubRepository(rows));
    await redactor.refresh();

    expect(redactor.resolve('activityValue', { campaignCode: 'CAMP1' })).toBe(true);
    expect(redactor.resolve('activityValue', { campaignCode: 'CAMP2' })).toBe(false);
    expect(redactor.resolve('activityValue', {})).toBe(false);
  });

  it('precedence is campaign > tenant > country > global, first match wins', async () => {
    const rows: FieldEncryptionConfigRow[] = [
      row({ scope_level: 'global', scope_ref: null, field_name: 'amount', is_encrypted: false }),
      row({ scope_level: 'country', scope_ref: 'US', field_name: 'amount', is_encrypted: false }),
      row({ scope_level: 'tenant', scope_ref: '7', field_name: 'amount', is_encrypted: true }),
      row({
        scope_level: 'campaign',
        scope_ref: 'CAMP1',
        field_name: 'amount',
        is_encrypted: false,
      }),
    ];
    const redactor = new LogRedactorService(stubRepository(rows));
    await redactor.refresh();

    // Tenant row wins over the country/global rows when no campaign-scoped row matches.
    expect(redactor.resolve('amount', { tenantId: 7, countryCode: 'US' })).toBe(true);
    // Campaign row wins over everything when it matches.
    expect(
      redactor.resolve('amount', { campaignCode: 'CAMP1', tenantId: 7, countryCode: 'US' }),
    ).toBe(false);
    // Falls through to country when campaign/tenant don't match or aren't provided.
    expect(redactor.resolve('amount', { countryCode: 'US' })).toBe(false);
  });

  it('degrades gracefully to the next level when part of the context is unavailable', async () => {
    const rows: FieldEncryptionConfigRow[] = [
      row({ scope_level: 'global', scope_ref: null, field_name: 'amount', is_encrypted: true }),
    ];
    const redactor = new LogRedactorService(stubRepository(rows));
    await redactor.refresh();

    // No campaign/tenant/country in context at all — falls straight through to global.
    expect(redactor.resolve('amount')).toBe(true);
  });

  it('redact returns the fixed placeholder token, never the raw value, when resolve is true', async () => {
    const redactor = new LogRedactorService(stubRepository(SEEDED_DEFAULT_ROWS));
    await redactor.refresh();
    expect(redactor.redact('customerId', 'CUST-00042-abc', {})).toBe('[REDACTED:customerId]');
  });

  it('redact returns the raw value unchanged when resolve is false', async () => {
    const redactor = new LogRedactorService(stubRepository(SEEDED_DEFAULT_ROWS));
    await redactor.refresh();
    expect(redactor.redact('activityValue', '42.00', {})).toBe('42.00');
  });

  it('refresh replaces the previous rule set rather than merging with it', async () => {
    const repository = stubRepository(SEEDED_DEFAULT_ROWS);
    const redactor = new LogRedactorService(repository);
    await redactor.refresh();
    expect(redactor.resolve('customerId', {})).toBe(true);

    (repository.findAll as jest.Mock).mockResolvedValue([
      row({
        scope_level: 'global',
        scope_ref: null,
        field_name: 'customerId',
        is_encrypted: false,
      }),
    ]);
    await redactor.refresh();
    expect(redactor.resolve('customerId', {})).toBe(false);
  });
});
