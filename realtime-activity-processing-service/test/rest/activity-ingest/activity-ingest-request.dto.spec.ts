/**
 * T-INT-054. Unit tests for `parseActivityIngestRequest`/`toInboundActivity` — the REST DTO's own
 * structural validation and mapping onto `InboundActivity`.
 */
import { BadRequestException } from '@nestjs/common';
import {
  parseActivityIngestRequest,
  toInboundActivity,
} from '@/rest/activity-ingest/activity-ingest-request.dto';

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: 1,
    customerId: 'priya-shah',
    customerIdType: 'EXTERNAL_ID',
    activityPerformedDate: '2026-09-01T10:15:30Z',
    activityCode: 'Grocery Purchase',
    activityType: 'Grocery Purchase',
    activityCategory: 'GENERAL',
    activityValue: '12.5',
    activityValueUnit: 'USD',
    channel: 'test-app-tracking-service',
    activityPerformedEnv: 'test-app-demo',
    activityName: 'Grocery Purchase',
    ...overrides,
  };
}

describe('parseActivityIngestRequest', () => {
  it('parses a well-formed body', () => {
    const dto = parseActivityIngestRequest(validBody());
    expect(dto.tenantId).toBe(1);
    expect(dto.customerId).toBe('priya-shah');
    expect(dto.activityPerformedDate).toBeInstanceOf(Date);
  });

  it('rejects a missing tenantId', () => {
    const { tenantId: _omit, ...body } = validBody();
    expect(() => parseActivityIngestRequest(body)).toThrow(BadRequestException);
  });

  it('rejects a non-positive tenantId', () => {
    expect(() => parseActivityIngestRequest(validBody({ tenantId: 0 }))).toThrow(
      BadRequestException,
    );
  });

  it('rejects a body missing both transactionType and activityCode', () => {
    const { activityCode: _omit, ...body } = validBody();
    expect(() => parseActivityIngestRequest(body)).toThrow(BadRequestException);
  });

  it('accepts transactionType in place of activityCode', () => {
    const { activityCode: _omit, ...body } = validBody();
    const dto = parseActivityIngestRequest({ ...body, transactionType: 'PURCHASE' });
    expect(dto.transactionType).toBe('PURCHASE');
  });

  it('rejects an activityPerformedDate with no explicit UTC offset', () => {
    expect(() =>
      parseActivityIngestRequest(validBody({ activityPerformedDate: '2026-09-01 10:15:30' })),
    ).toThrow(BadRequestException);
  });

  it('rejects a non-decimal activityValue', () => {
    expect(() => parseActivityIngestRequest(validBody({ activityValue: 'not-a-number' }))).toThrow(
      BadRequestException,
    );
  });

  it('rejects a missing required field, naming it in the error message', () => {
    const { activityValueUnit: _omit, ...body } = validBody();
    expect(() => parseActivityIngestRequest(body)).toThrow(/activityValueUnit/);
  });
});

describe('toInboundActivity', () => {
  it('maps a parsed DTO onto InboundActivity with sourceTransport REST', () => {
    const dto = parseActivityIngestRequest(validBody());
    const activity = toInboundActivity(dto);

    expect(activity.sourceTransport).toBe('REST');
    expect(activity.tenantId).toBe(1);
    expect(activity.customerId).toBe('priya-shah');
  });
});
