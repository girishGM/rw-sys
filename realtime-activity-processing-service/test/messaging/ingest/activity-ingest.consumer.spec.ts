/**
 * T-RAP-023. Unit tests for `ActivityIngestConsumer.processMessage` — `ActivityIngestionService`
 * and `ActivityIngestDlqPublisher` are hand-rolled fakes, no DB, no Kafka, no Nest test module
 * (same discipline `activity-ingestion.service.spec.ts`, T-RAP-021, already established for this
 * project). Real-broker behaviour (TC-5's actual partition load-balancing, DLQ topic inspection)
 * is proven separately in `activity-ingest.consumer.e2e-spec.ts`; this suite proves
 * `processMessage`'s own orchestration — what gets validated/passed to `ingest()`, and how its
 * outcome (or a thrown error) becomes an ack-vs-DLQ decision.
 */
import type { ConfigService } from '@nestjs/config';
import {
  ActivityIngestConsumer,
  type ActivityIngestDlqPublisher,
} from '@/messaging/ingest/activity-ingest.consumer';
import type { ActivityIngestionService } from '@/modules/activity-mapping/activity-ingestion.service';
import type { Config } from '@/config/config.schema';

const BACKOFF_BASE_MS = 1;
const BACKOFF_MAX_MS = 5;

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

interface Harness {
  consumer: ActivityIngestConsumer;
  ingest: jest.Mock;
  publish: jest.Mock;
}

function buildHarness(ingestImpl?: jest.Mock): Harness {
  const ingest =
    ingestImpl ??
    jest.fn().mockResolvedValue({
      correlationId: 'corr-1',
      dedupKey: 'evt-1',
      status: 'accepted',
      matchedTrackerComponents: ['COMP1'],
    });
  const publish = jest.fn().mockResolvedValue(undefined);

  const ingestionService = { ingest } as unknown as ActivityIngestionService;
  const dlqPublisher = { publish } as unknown as ActivityIngestDlqPublisher;
  const configService = {} as ConfigService<Config, true>;

  const consumer = new ActivityIngestConsumer(
    ingestionService,
    dlqPublisher,
    configService,
    BACKOFF_BASE_MS,
    BACKOFF_MAX_MS,
  );

  return { consumer, ingest, publish };
}

describe('ActivityIngestConsumer.processMessage', () => {
  // TC-1
  it('TC-1: a valid message matching one active component is ingested and acknowledged', async () => {
    const { consumer, ingest, publish } = buildHarness();

    const outcome = await consumer.processMessage({
      key: 'cust-1',
      value: JSON.stringify(validBody()),
    });

    expect(outcome).toBe('ACK');
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 1,
        customerId: 'cust-1',
        activityCode: 'PURCHASE',
        sourceTransport: 'KAFKA',
      }),
    );
    expect(publish).not.toHaveBeenCalled();
  });

  // TC-2
  it('TC-2: a message missing a mandatory field is retried, then routed to DLQ with the reason attached', async () => {
    const { consumer, ingest, publish } = buildHarness();

    const outcome = await consumer.processMessage({
      key: 'cust-1',
      value: JSON.stringify(validBody({ customerId: undefined })),
    });

    expect(outcome).toBe('DLQ');
    expect(ingest).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    const [key, message] = publish.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(key).toBe('cust-1');
    expect(message.error).toMatch(/customerId/);
    expect(typeof message.failedAt).toBe('string');
    // Original body fields are preserved alongside the failure metadata.
    expect(message.activityCode).toBe('PURCHASE');
  });

  // TC-3
  it('TC-3: a timestamp lacking a UTC offset is retried, then routed to DLQ', async () => {
    const { consumer, ingest, publish } = buildHarness();

    const outcome = await consumer.processMessage({
      key: 'cust-1',
      value: JSON.stringify(validBody({ activityPerformedDate: '2026-09-01 10:00:00' })),
    });

    expect(outcome).toBe('DLQ');
    expect(ingest).not.toHaveBeenCalled();
    const [, message] = publish.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(message.error).toMatch(/activityPerformedDate/);
  });

  it('a message that is not valid JSON at all is retried, then routed to DLQ with the raw value preserved', async () => {
    const { consumer, ingest, publish } = buildHarness();

    const outcome = await consumer.processMessage({ key: 'cust-1', value: 'not-json{{{' });

    expect(outcome).toBe('DLQ');
    expect(ingest).not.toHaveBeenCalled();
    const [, message] = publish.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(message.raw).toBe('not-json{{{');
  });

  // TC-4
  it('TC-4: a redelivered message whose dedupKey is already fully processed is a safe no-op', async () => {
    const ingest = jest.fn().mockResolvedValue({
      correlationId: 'corr-1',
      dedupKey: 'evt-1',
      status: 'duplicate',
      matchedTrackerComponents: [],
    });
    const { consumer, publish } = buildHarness(ingest);

    const outcome = await consumer.processMessage({
      key: 'cust-1',
      value: JSON.stringify(validBody()),
    });

    expect(outcome).toBe('ACK');
    expect(publish).not.toHaveBeenCalled();
  });

  // TC-6
  it('TC-6: a message that validates but matches no active component is NOT a DLQ case', async () => {
    const ingest = jest.fn().mockResolvedValue({
      correlationId: 'corr-1',
      dedupKey: 'evt-1',
      status: 'accepted',
      matchedTrackerComponents: [],
    });
    const { consumer, publish } = buildHarness(ingest);

    const outcome = await consumer.processMessage({
      key: 'cust-1',
      value: JSON.stringify(validBody()),
    });

    expect(outcome).toBe('ACK');
    expect(publish).not.toHaveBeenCalled();
  });

  // TC-7 (simulated): a "crash between DB commit and offset commit" is, from this method's own
  // point of view, indistinguishable from a plain redelivery — calling `processMessage` twice
  // with the identical message is the exact scenario (this method itself never manages offsets;
  // that is kafkajs's own job once the returned promise resolves, per this class's own header).
  it('TC-7: redelivery after a simulated crash is handled identically to TC-4', async () => {
    const ingest = jest
      .fn()
      .mockResolvedValueOnce({
        correlationId: 'corr-1',
        dedupKey: 'evt-1',
        status: 'accepted',
        matchedTrackerComponents: ['COMP1'],
      })
      .mockResolvedValueOnce({
        correlationId: 'corr-1',
        dedupKey: 'evt-1',
        status: 'duplicate',
        matchedTrackerComponents: [],
      });
    const { consumer, publish } = buildHarness(ingest);
    const raw = { key: 'cust-1', value: JSON.stringify(validBody()) };

    const first = await consumer.processMessage(raw);
    const second = await consumer.processMessage(raw);

    expect(first).toBe('ACK');
    expect(second).toBe('ACK');
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
  });

  it('a transient ingest() failure is retried up to MAX_PROCESSING_ATTEMPTS before DLQ', async () => {
    const ingest = jest.fn().mockRejectedValue(new Error('transient db blip'));
    const { consumer, publish } = buildHarness(ingest);

    const outcome = await consumer.processMessage({
      key: 'cust-1',
      value: JSON.stringify(validBody()),
    });

    expect(outcome).toBe('DLQ');
    expect(ingest).toHaveBeenCalledTimes(3);
    const [, message] = publish.mock.calls[0] as [string | null, Record<string, unknown>];
    expect(message.error).toBe('transient db blip');
  });

  it('a DLQ publish failure surfaces as a thrown error rather than being silently swallowed', async () => {
    const ingest = jest.fn();
    const { consumer, publish } = buildHarness(ingest);
    publish.mockRejectedValue(new Error('broker unreachable'));

    await expect(
      consumer.processMessage({
        key: 'cust-1',
        value: JSON.stringify(validBody({ customerId: undefined })),
      }),
    ).rejects.toThrow('broker unreachable');
  });
});
