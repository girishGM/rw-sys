/**
 * T-RAP-023. Pure unit tests for `validateActivityIngestMessage` — no Nest, no DB, no Kafka.
 */
import { validateActivityIngestMessage } from '@/messaging/ingest/activity-ingest-schema.validator';

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: 1,
    customerId: 'cust-1',
    customerIdType: 'INTERNAL_ID',
    activityPerformedDate: '2026-09-01T10:15:30Z',
    activityCode: 'PURCHASE',
    activityType: 'TRANSACTION',
    activityCategory: 'RETAIL',
    activityValue: '100.0000',
    activityValueUnit: 'USD',
    channel: 'WEB',
    activityPerformedEnv: 'PROD',
    activityName: 'Online purchase',
    activityEventId: 'evt-1',
    ...overrides,
  };
}

describe('validateActivityIngestMessage', () => {
  it('accepts a fully valid payload and maps every field onto InboundActivity', () => {
    const result = validateActivityIngestMessage(validBody());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activity).toMatchObject({
      tenantId: 1,
      customerId: 'cust-1',
      customerIdType: 'INTERNAL_ID',
      activityCode: 'PURCHASE',
      transactionType: undefined,
      activityType: 'TRANSACTION',
      activityCategory: 'RETAIL',
      activityValue: '100.0000',
      activityValueUnit: 'USD',
      channel: 'WEB',
      activityPerformedEnv: 'PROD',
      activityName: 'Online purchase',
      activityEventId: 'evt-1',
      sourceTransport: 'KAFKA',
    });
    expect(result.activity.activityPerformedDate).toBeInstanceOf(Date);
  });

  it('accepts transactionType in place of activityCode', () => {
    const result = validateActivityIngestMessage(
      validBody({ activityCode: undefined, transactionType: 'REFUND' }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a non-object payload', () => {
    expect(validateActivityIngestMessage('not-an-object').ok).toBe(false);
    expect(validateActivityIngestMessage(null).ok).toBe(false);
    expect(validateActivityIngestMessage([1, 2]).ok).toBe(false);
  });

  it('rejects a missing/non-integer tenantId', () => {
    const missing = validateActivityIngestMessage(validBody({ tenantId: undefined }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toMatch(/tenantId/);

    const nonInteger = validateActivityIngestMessage(validBody({ tenantId: 1.5 }));
    expect(nonInteger.ok).toBe(false);
  });

  it.each([
    'customerId',
    'customerIdType',
    'activityType',
    'activityCategory',
    'activityValueUnit',
    'channel',
    'activityPerformedEnv',
    'activityName',
  ])('rejects a missing mandatory field: %s', (field) => {
    const result = validateActivityIngestMessage(validBody({ [field]: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(new RegExp(field));
  });

  it('rejects a payload missing both transactionType and activityCode', () => {
    const result = validateActivityIngestMessage(
      validBody({ activityCode: undefined, transactionType: undefined }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/transactionType or activityCode/);
  });

  it('rejects a non-decimal activityValue', () => {
    const result = validateActivityIngestMessage(validBody({ activityValue: 'not-a-number' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/activityValue/);
  });

  it('rejects an activityPerformedDate with no explicit UTC offset', () => {
    const result = validateActivityIngestMessage(
      validBody({ activityPerformedDate: '2026-09-01 10:00:00' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/activityPerformedDate/);
  });

  it('rejects a missing activityPerformedDate', () => {
    const result = validateActivityIngestMessage(validBody({ activityPerformedDate: undefined }));
    expect(result.ok).toBe(false);
  });

  it('treats an empty-string optional field the same as absent', () => {
    const result = validateActivityIngestMessage(
      validBody({ merchantCode: '', correlationId: '' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.activity.merchantCode).toBeUndefined();
    expect(result.activity.correlationId).toBeUndefined();
  });
});
