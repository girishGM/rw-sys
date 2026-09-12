/**
 * T-RR-011. Fast, mocked-dependency unit tests for `RewardIngestController` plus the static,
 * file-content checks R10's own discipline calls for — kept as real, automated regression tests
 * (not just a one-off command run once at review time) so a future change that reintroduces
 * mapping/idempotency/persistence logic into this transport adapter fails CI immediately. Same
 * split as `activity-ingest.controller.spec.ts`/`grpc-server.e2e-spec.ts` (T-RAP-022): the real-
 * mTLS/real-Postgres round trip (TC-1, TC-2, TC-5, TC-6, TC-7) lives in
 * `reward-ingest.e2e-spec.ts`.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { RewardIngestController } from '@/grpc/reward-ingest.controller';
import { ResolvedIdentityContext } from '@/grpc/resolved-identity.context';
import type {
  RewardIngestionService,
  IngestResult,
} from '@/modules/reward-ingestion/reward-ingestion.service';
import type { RewardEntryIngestDto } from '@/modules/reward-ingestion/reward-entry-ingest.dto';

const CONTROLLER_SOURCE_PATH = join(
  __dirname,
  '..',
  '..',
  'src',
  'grpc',
  'reward-ingest.controller.ts',
);
const PROTO_PATH = join(__dirname, '..', '..', 'proto', 'reward_ingest.proto');

function buildController(ingest: jest.Mock): {
  controller: RewardIngestController;
  identityContext: ResolvedIdentityContext;
} {
  const ingestionService = { ingest } as unknown as RewardIngestionService;
  const identityContext = new ResolvedIdentityContext();
  return {
    controller: new RewardIngestController(ingestionService, identityContext),
    identityContext,
  };
}

const receivedResult: IngestResult = {
  rewardEntryId: 'reward-entry-1',
  status: 'received',
};

const validRequest = {
  id: 'reward-entry-1',
  correlationId: 'corr-1',
  tenantId: 1,
  customerId: 'CUST-1',
  customerIdType: 'MSISDN',
  activityPerformedDate: '2026-09-04T10:15:00Z',
  activityCode: 'TXN_TOPUP',
  activityType: 'TOPUP',
  activityCategory: 'TELCO',
  activityValue: '50.0000',
  activityValueUnit: 'MYR',
  channel: 'app',
  activityPerformedEnv: 'production',
  activityName: 'Prepaid Top-up',
  campaignCode: 'CAMP-2026-Q3-001',
  trackerCode: 'TRK-TOPUP-5X',
  trackerComponentCode: 'CMP-TOPUP-STEP-3',
  rewardCode: 'RWD-CASHBACK-5PCT',
  rewardCategory: 'CASHBACK',
  rewardValue: '2.5000',
  rewardValueUnit: 'MYR',
  rewardEntryDate: '2026-09-04T10:15:03Z',
  completionCycle: 1,
};

describe('T-RR-011 — RewardIngestController (unit, mocked domain service)', () => {
  // TC-1: valid request maps onto RewardEntryIngestDto, calls the domain method, maps the
  // IngestResult back.
  it('maps a valid RewardEntry to RewardEntryIngestDto and the received IngestResult back to the ack', async () => {
    const ingest = jest.fn().mockResolvedValue(receivedResult);
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 55);

    const response = await controller.submitRewardEntry(validRequest, undefined, call);

    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'reward-entry-1',
        correlationId: 'corr-1',
        tenantId: 1,
        customerId: 'CUST-1',
        customerIdType: 'MSISDN',
        activityCode: 'TXN_TOPUP',
        transactionType: null,
        activityType: 'TOPUP',
        activityCategory: 'TELCO',
        activityValue: '50.0000',
        activityValueUnit: 'MYR',
        channel: 'app',
        activityPerformedEnv: 'production',
        activityName: 'Prepaid Top-up',
        campaignCode: 'CAMP-2026-Q3-001',
        trackerCode: 'TRK-TOPUP-5X',
        trackerComponentCode: 'CMP-TOPUP-STEP-3',
        merchantCode: null,
        rewardCode: 'RWD-CASHBACK-5PCT',
        rewardCategory: 'CASHBACK',
        rewardValue: '2.5000',
        rewardValueUnit: 'MYR',
        completionCycle: 1,
        ingestionChannel: 'GRPC',
      }),
    );
    const [[passedDto]] = ingest.mock.calls as [[RewardEntryIngestDto]];
    expect(passedDto.activityPerformedDate).toBeInstanceOf(Date);
    expect(passedDto.activityPerformedDate.toISOString()).toBe('2026-09-04T10:15:00.000Z');
    expect(passedDto.rewardEntryDate).toBeInstanceOf(Date);
    expect(passedDto.rewardEntryDate.toISOString()).toBe('2026-09-04T10:15:03.000Z');

    expect(response).toEqual({ rewardEntryId: 'reward-entry-1', status: 'received' });
  });

  // TC-2 (duplicate): `IngestResult.status` from a duplicate's already-existing row maps straight
  // through — no gRPC error, no invented status.
  it('maps a duplicate-arrival IngestResult straight through, unchanged, never as an error', async () => {
    const processingResult: IngestResult = {
      rewardEntryId: 'reward-entry-1',
      status: 'processing',
    };
    const ingest = jest.fn().mockResolvedValue(processingResult);
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    const response = await controller.submitRewardEntry(validRequest, undefined, call);

    expect(response).toEqual({ rewardEntryId: 'reward-entry-1', status: 'processing' });
  });

  // TC-3 (negative): missing `id` is INVALID_ARGUMENT, never reaches the domain method.
  it('rejects a request missing id with INVALID_ARGUMENT, without calling ingest()', async () => {
    const ingest = jest.fn();
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);
    const { id: _omit, ...withoutId } = validRequest;

    await expect(controller.submitRewardEntry(withoutId, undefined, call)).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.INVALID_ARGUMENT }),
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rejects a request with an empty-string id with INVALID_ARGUMENT, without calling ingest()', async () => {
    const ingest = jest.fn();
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    await expect(
      controller.submitRewardEntry({ ...validRequest, id: '' }, undefined, call),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.INVALID_ARGUMENT }),
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  // TC-4 (negative): an unparseable/offset-less activity_performed_date is INVALID_ARGUMENT.
  it('rejects an activity_performed_date with no explicit UTC offset, without calling ingest()', async () => {
    const ingest = jest.fn();
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    await expect(
      controller.submitRewardEntry(
        { ...validRequest, activityPerformedDate: '2026-09-04 10:15:00' },
        undefined,
        call,
      ),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.INVALID_ARGUMENT }),
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rejects a request whose reward_entry_date does not parse at all, without calling ingest()', async () => {
    const ingest = jest.fn();
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    await expect(
      controller.submitRewardEntry(
        { ...validRequest, rewardEntryDate: 'not-a-date' },
        undefined,
        call,
      ),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.INVALID_ARGUMENT }),
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rejects a non-decimal activity_value with INVALID_ARGUMENT, without calling ingest()', async () => {
    const ingest = jest.fn();
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    await expect(
      controller.submitRewardEntry(
        { ...validRequest, activityValue: 'not-a-number' },
        undefined,
        call,
      ),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.INVALID_ARGUMENT }),
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rejects a non-decimal reward_value with INVALID_ARGUMENT, without calling ingest()', async () => {
    const ingest = jest.fn();
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    await expect(
      controller.submitRewardEntry({ ...validRequest, rewardValue: '1e10' }, undefined, call),
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
      controller.submitRewardEntry(withoutActivityCode, undefined, call),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.INVALID_ARGUMENT }),
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('accepts a transaction_type-only request (no activity_code)', async () => {
    const ingest = jest.fn().mockResolvedValue(receivedResult);
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);
    const { activityCode: _omit, ...withoutActivityCode } = validRequest;

    await controller.submitRewardEntry(
      { ...withoutActivityCode, transactionType: 'TXN_PURCHASE' },
      undefined,
      call,
    );

    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ transactionType: 'TXN_PURCHASE', activityCode: null }),
    );
  });

  it('rejects a tenant_id of zero (proto3 unset sentinel) with INVALID_ARGUMENT', async () => {
    const ingest = jest.fn();
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    await expect(
      controller.submitRewardEntry({ ...validRequest, tenantId: 0 }, undefined, call),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.INVALID_ARGUMENT }),
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('propagates the wire tenant_id verbatim, never the mTLS-resolved identity tenantId', async () => {
    const ingest = jest.fn().mockResolvedValue(receivedResult);
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    // Resolved identity tenantId (99) deliberately differs from the wire's own tenant_id (1) —
    // proves the DTO's tenantId always comes from the payload, per this controller's own header.
    identityContext.set(call, 99);

    await controller.submitRewardEntry({ ...validRequest, tenantId: 1 }, undefined, call);

    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 1 }));
  });

  // T-INT-046 TC-2: an empty reward_value_unit is accepted (not INVALID_ARGUMENT) — some reward
  // kinds (PROMO_CODE/POINTS) have no fixed currency/point unit by design.
  it('accepts an empty-string reward_value_unit, passing it through as "" (no unit for this reward kind)', async () => {
    const ingest = jest.fn().mockResolvedValue(receivedResult);
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    const response = await controller.submitRewardEntry(
      { ...validRequest, rewardValueUnit: '' },
      undefined,
      call,
    );

    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ rewardValueUnit: '' }));
    expect(response).toEqual({ rewardEntryId: 'reward-entry-1', status: 'received' });
  });

  it('accepts a request with reward_value_unit omitted entirely, passing it through as ""', async () => {
    const ingest = jest.fn().mockResolvedValue(receivedResult);
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);
    const { rewardValueUnit: _omit, ...withoutRewardValueUnit } = validRequest;

    await controller.submitRewardEntry(withoutRewardValueUnit, undefined, call);

    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ rewardValueUnit: '' }));
  });

  it('propagates merchant_code verbatim, omitting an empty string as null', async () => {
    const ingest = jest.fn().mockResolvedValue(receivedResult);
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    await controller.submitRewardEntry(
      { ...validRequest, merchantCode: 'MERCH1' },
      undefined,
      call,
    );

    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ merchantCode: 'MERCH1' }));
  });

  // T-INT-058 TC-1/TC-4: reward_kind/promo_code_config_id/promo_code_config_version_no.
  it('T-INT-058 TC-1: propagates reward_kind/promo_code_config_id/promo_code_config_version_no verbatim when present', async () => {
    const ingest = jest.fn().mockResolvedValue(receivedResult);
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    await controller.submitRewardEntry(
      {
        ...validRequest,
        rewardKind: 'PROMO_CODE',
        promoCodeConfigId: 'PCC-001',
        promoCodeConfigVersionNo: 3,
      },
      undefined,
      call,
    );

    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        rewardKind: 'PROMO_CODE',
        promoCodeConfigId: 'PCC-001',
        promoCodeConfigVersionNo: 3,
      }),
    );
  });

  it('T-INT-058 TC-4: an old-shaped request omitting reward_kind/promo_code_config_id/promo_code_config_version_no still succeeds, all three null', async () => {
    const ingest = jest.fn().mockResolvedValue(receivedResult);
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    const response = await controller.submitRewardEntry(validRequest, undefined, call);

    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        rewardKind: null,
        promoCodeConfigId: null,
        promoCodeConfigVersionNo: null,
      }),
    );
    expect(response).toEqual({ rewardEntryId: 'reward-entry-1', status: 'received' });
  });

  it('T-INT-058: treats reward_kind "" / promo_code_config_version_no 0 (proto3 unset sentinels) as null, not an error', async () => {
    const ingest = jest.fn().mockResolvedValue(receivedResult);
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    await controller.submitRewardEntry(
      { ...validRequest, rewardKind: '', promoCodeConfigId: '', promoCodeConfigVersionNo: 0 },
      undefined,
      call,
    );

    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        rewardKind: null,
        promoCodeConfigId: null,
        promoCodeConfigVersionNo: null,
      }),
    );
  });

  it('T-INT-058: an unrecognized reward_kind value degrades to null, never INVALID_ARGUMENT (descriptive-only metadata)', async () => {
    const ingest = jest.fn().mockResolvedValue(receivedResult);
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);

    await controller.submitRewardEntry(
      { ...validRequest, rewardKind: 'NOT_A_REAL_KIND' },
      undefined,
      call,
    );

    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ rewardKind: null }));
  });

  it('rejects a request missing a required field (customer_id) with INVALID_ARGUMENT', async () => {
    const ingest = jest.fn();
    const { controller, identityContext } = buildController(ingest);
    const call = {};
    identityContext.set(call, 1);
    const { customerId: _omit, ...withoutCustomerId } = validRequest;

    await expect(
      controller.submitRewardEntry(withoutCustomerId, undefined, call),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.INVALID_ARGUMENT }),
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  // Defensive branch: MtlsGuard always sets a tenantId before this handler runs; this proves the
  // controller does not silently proceed with an unresolved caller identity if that guarantee
  // ever broke.
  it('throws INTERNAL when no caller identity was resolved for this call (defensive — should never happen with MtlsGuard in front)', async () => {
    const ingest = jest.fn();
    const { controller } = buildController(ingest);

    await expect(controller.submitRewardEntry(validRequest, undefined, {})).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.INTERNAL }),
    });
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe('T-RR-011 — R10 code-inspection guard (no business logic in a transport adapter)', () => {
  const controllerSource = readFileSync(CONTROLLER_SOURCE_PATH, 'utf8');

  it('the controller never references persistence/encryption/repository internals of its own', () => {
    const forbiddenSymbols = [
      'RewardRedemptionEntryRepository',
      'EncryptionService',
      'LogRedactorService',
      'ON CONFLICT',
      'pg.Pool',
      'new Pool(',
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

describe('T-RR-011 — proto file structural checks', () => {
  const proto = readFileSync(PROTO_PATH, 'utf8');

  it('declares package rewardrap.reward.v1 (byte-for-byte, never renamed)', () => {
    expect(proto).toMatch(/^package rewardrap\.reward\.v1;$/m);
  });

  it('declares exactly one RPC, SubmitRewardEntry', () => {
    const rpcLines = proto
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('rpc '));
    expect(rpcLines).toHaveLength(1);
    expect(rpcLines[0]).toMatch(/^rpc SubmitRewardEntry /);
  });

  it('activity_value and reward_value are declared as string, never a numeric proto type', () => {
    const numericTypes =
      '(double|float|int32|int64|uint32|uint64|sint32|sint64|fixed32|fixed64|sfixed32|sfixed64)';
    for (const field of ['activity_value', 'reward_value']) {
      expect(proto).toMatch(new RegExp(`string\\s+${field}\\s*=`));
      expect(proto).not.toMatch(new RegExp(`${numericTypes}\\s+${field}\\s*=`));
    }
  });

  // Unlike RAP's own SubmitActivityRequest, RewardEntry DOES carry tenant_id on the wire — this
  // controller's own header documents why (a resolved design-doc contradiction).
  it('RewardEntry declares an int32 tenant_id field', () => {
    const requestBlockMatch = proto.match(/message RewardEntry \{([\s\S]*?)\n\}/);
    expect(requestBlockMatch).not.toBeNull();
    expect(requestBlockMatch?.[1] ?? '').toMatch(/int32\s+tenant_id\s*=\s*3;/);
  });

  it("never renumbers field 1 (id) or field 25 (completion_cycle) away from RAP's real file", () => {
    expect(proto).toMatch(/string\s+id\s+=\s*1;/);
    expect(proto).toMatch(/int32\s+completion_cycle\s+=\s*25;/);
  });

  // T-INT-058: fields 26-28 copied field-number-for-field-number from RAP's own real proto.
  it('declares reward_kind (26), promo_code_config_id (27), promo_code_config_version_no (28) at RAP-matching field numbers/types', () => {
    expect(proto).toMatch(/string\s+reward_kind\s+=\s*26;/);
    expect(proto).toMatch(/string\s+promo_code_config_id\s+=\s*27;/);
    expect(proto).toMatch(/int32\s+promo_code_config_version_no\s*=\s*28;/);
  });
});
