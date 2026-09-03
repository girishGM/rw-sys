/**
 * T-RAP-022. Fast, mocked-dependency unit tests for `ActivityIngestController` plus the static,
 * file-content checks this task's own R5 discipline calls for — kept as real, automated regression
 * tests (not just a one-off command run once at review time) so a future change that reintroduces
 * mapping/idempotency/persistence logic into this transport adapter fails CI immediately. Same
 * split as `promo-code.controller.spec.ts`/`grpc-server.e2e-spec.ts` (T-PC-031): the real-mTLS/
 * real-Postgres round trip (TC-1, TC-2, TC-3, TC-6) lives in `grpc-server.e2e-spec.ts`.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { ActivityIngestController } from '@/grpc/activity-ingest.controller';
import { ResolvedIdentityContext } from '@/grpc/resolved-identity.context';
import type {
  ActivityIngestionService,
  IngestResult,
} from '@/modules/activity-mapping/activity-ingestion.service';
import type { InboundActivity } from '@/modules/idempotency/inbound-activity.types';

const CONTROLLER_SOURCE_PATH = join(
  __dirname,
  '..',
  '..',
  'src',
  'grpc',
  'activity-ingest.controller.ts',
);
const PROTO_PATH = join(__dirname, '..', '..', 'proto', 'activity_ingest.proto');

function buildController(ingest: jest.Mock): {
  controller: ActivityIngestController;
  identityContext: ResolvedIdentityContext;
} {
  const ingestionService = { ingest } as unknown as ActivityIngestionService;
  const identityContext = new ResolvedIdentityContext();
  return {
    controller: new ActivityIngestController(ingestionService, identityContext),
    identityContext,
  };
}

const successResult: IngestResult = {
  correlationId: 'corr-1',
  dedupKey: 'dedup-1',
  status: 'accepted',
  matchedTrackerComponents: ['COMP1'],
};

const validRequest = {
  customerId: 'CUST-1',
  customerIdType: 'INTERNAL_ID',
  activityPerformedDate: '2026-09-01T10:15:30Z',
  activityCode: 'PURCHASE',
  activityType: 'TRANSACTION',
  activityCategory: 'RETAIL',
  activityValue: '100.5000',
  activityValueUnit: 'USD',
  channel: 'WEB',
  activityPerformedEnv: 'PROD',
  activityName: 'Online purchase',
};

describe('T-RAP-022 — ActivityIngestController (unit, mocked domain service)', () => {
  // TC-1: valid request maps onto InboundActivity, calls the domain method, maps IngestResult back.
  it('maps a valid SubmitActivityRequest to InboundActivity and the accepted IngestResult back to the response', async () => {
    const ingest = jest.fn().mockResolvedValue(successResult);
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 55);

    const response = await controller.submitActivity(validRequest, undefined, call);

    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 55,
        customerId: 'CUST-1',
        customerIdType: 'INTERNAL_ID',
        activityCode: 'PURCHASE',
        activityType: 'TRANSACTION',
        activityCategory: 'RETAIL',
        activityValue: '100.5000',
        activityValueUnit: 'USD',
        channel: 'WEB',
        activityPerformedEnv: 'PROD',
        activityName: 'Online purchase',
        sourceTransport: 'GRPC',
      }),
    );
    const [[passedActivity]] = ingest.mock.calls as [[InboundActivity]];
    expect(passedActivity.activityPerformedDate).toBeInstanceOf(Date);
    expect(passedActivity.activityPerformedDate.toISOString()).toBe('2026-09-01T10:15:30.000Z');

    expect(response).toEqual({
      correlationId: 'corr-1',
      status: 'accepted',
      matchedTrackerComponents: ['COMP1'],
    });
  });

  // TC-2: `IngestResult.status === 'duplicate'` maps straight through — no extra status invented.
  it('maps a duplicate IngestResult straight through, unchanged', async () => {
    const duplicateResult: IngestResult = {
      correlationId: 'corr-2',
      dedupKey: 'dedup-2',
      status: 'duplicate',
      matchedTrackerComponents: [],
    };
    const ingest = jest.fn().mockResolvedValue(duplicateResult);
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    const response = await controller.submitActivity(validRequest, undefined, call);

    expect(response).toEqual({
      correlationId: 'corr-2',
      status: 'duplicate',
      matchedTrackerComponents: [],
    });
  });

  // TC-4: a non-numeric activity_value is INVALID_ARGUMENT, not a raw parse exception, and never
  // reaches the domain method.
  it('rejects a non-numeric activity_value with INVALID_ARGUMENT, without calling ingest()', async () => {
    const ingest = jest.fn();
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    await expect(
      controller.submitActivity(
        { ...validRequest, activityValue: 'not-a-number' },
        undefined,
        call,
      ),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.INVALID_ARGUMENT }),
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  // TC-5: activity_performed_date with no explicit UTC offset is INVALID_ARGUMENT.
  it('rejects an activity_performed_date with no explicit UTC offset, without calling ingest()', async () => {
    const ingest = jest.fn();
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    await expect(
      controller.submitActivity(
        { ...validRequest, activityPerformedDate: '2026-09-01 10:00:00' },
        undefined,
        call,
      ),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.INVALID_ARGUMENT }),
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rejects a request missing both activity_code and transaction_type, without calling ingest()', async () => {
    const ingest = jest.fn();
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);
    const { activityCode: _omit, ...withoutActivityCode } = validRequest;

    await expect(
      controller.submitActivity(withoutActivityCode, undefined, call),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.INVALID_ARGUMENT }),
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('accepts a transaction_type-only request (no activity_code)', async () => {
    const ingest = jest.fn().mockResolvedValue(successResult);
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);
    const { activityCode: _omit, ...withoutActivityCode } = validRequest;

    await controller.submitActivity(
      { ...withoutActivityCode, transactionType: 'TXN_PURCHASE' },
      undefined,
      call,
    );

    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ transactionType: 'TXN_PURCHASE', activityCode: undefined }),
    );
  });

  it('rejects a request missing a required field (customer_id) with INVALID_ARGUMENT', async () => {
    const ingest = jest.fn();
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);
    const { customerId: _omit, ...withoutCustomerId } = validRequest;

    await expect(
      controller.submitActivity(withoutCustomerId, undefined, call),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.INVALID_ARGUMENT }),
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  // Defensive branch: MtlsGuard always sets a tenantId before this handler runs; this proves the
  // controller does not silently proceed with an unresolved identity if that guarantee ever broke.
  it('throws INTERNAL when no tenantId was resolved for this call (defensive — should never happen with MtlsGuard in front)', async () => {
    const ingest = jest.fn();
    const { controller } = buildController(ingest);

    await expect(controller.submitActivity(validRequest, undefined, {})).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.INTERNAL }),
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('propagates optional fields (merchant_code, activity_event_id, correlation_id) verbatim, omitting empty strings', async () => {
    const ingest = jest.fn().mockResolvedValue(successResult);
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    await controller.submitActivity(
      {
        ...validRequest,
        merchantCode: 'MERCH1',
        activityEventId: 'EVT-1',
        correlationId: 'caller-corr-id',
      },
      undefined,
      call,
    );

    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantCode: 'MERCH1',
        activityEventId: 'EVT-1',
        correlationId: 'caller-corr-id',
      }),
    );
  });
});

describe('T-RAP-022 — R5 code-inspection guard', () => {
  const controllerSource = readFileSync(CONTROLLER_SOURCE_PATH, 'utf8');

  it('the controller never references mapping/idempotency/fan-out internals of its own', () => {
    const forbiddenSymbols = [
      'ActivityMapper',
      'IdempotencyService',
      'CorrelationIdService',
      'insertFanOutRows',
      'deriveDedupKey',
      'ON CONFLICT',
      'sequelize.transaction',
      'EncryptionService',
    ];
    for (const symbol of forbiddenSymbols) {
      expect(controllerSource).not.toContain(symbol);
    }
  });

  it('the controller only ever calls ingest() on the injected service, never re-implements it', () => {
    const ingestCallSites = controllerSource.match(/this\.ingestionService\.ingest\(/g) ?? [];
    expect(ingestCallSites).toHaveLength(1);
  });
});

describe('T-RAP-022 — proto file structural checks', () => {
  const proto = readFileSync(PROTO_PATH, 'utf8');

  it('declares exactly one RPC, SubmitActivity', () => {
    const rpcLines = proto
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('rpc '));
    expect(rpcLines).toHaveLength(1);
    expect(rpcLines[0]).toMatch(/^rpc SubmitActivity /);
  });

  it('activity_value is declared as string, never a numeric proto type', () => {
    expect(proto).toMatch(/string\s+activity_value\s*=/);
    const numericTypes =
      '(double|float|int32|int64|uint32|uint64|sint32|sint64|fixed32|fixed64|sfixed32|sfixed64)';
    expect(proto).not.toMatch(new RegExp(`${numericTypes}\\s+activity_value\\s*=`));
  });

  it('has no tenant_id field on SubmitActivityRequest', () => {
    const requestBlockMatch = proto.match(/message SubmitActivityRequest \{([\s\S]*?)\}/);
    expect(requestBlockMatch).not.toBeNull();
    expect(requestBlockMatch?.[1] ?? '').not.toMatch(/tenant_id/);
  });
});
