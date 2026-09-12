/**
 * T-INT-058 TC-5. Proves the wire contract itself, not just a hand-built DTO object — per
 * `AGENT-PROTOCOL.md` §3's own "assert the observable property, not the implementation string"
 * rule for anything a network protocol ultimately judges. Encodes a real `RewardEntry` message
 * using RAP's own real, shipped `proto/reward_ingest.proto`
 * (`realtime-activity-processing-service/proto/reward_ingest.proto`, `T-RAP-062`'s own field
 * numbers) via real `@grpc/proto-loader` serialization, then decodes the resulting bytes using this
 * service's own (now-corrected) copy of the same file. Fields 26-28
 * (`reward_kind`/`promo_code_config_id`/`promo_code_config_version_no`) must survive the round trip
 * unchanged — this is exactly the property that was silently broken before this task (RR's own
 * proto stopped at field 25, so any real RAP-originated field 26-28 value was simply absent from
 * whatever RR's own proto-loader-decoded object looked like at runtime).
 *
 * Deliberately does not use `grpc-server.config.ts`'s `resolveProtoPath()` for the RAP side — that
 * helper only ever resolves *this* service's own proto file. Both paths are built directly here
 * instead, the same way `test-grpc-client.ts`'s own header explains for the RR-side load.
 */
import { join } from 'node:path';
import * as protoLoader from '@grpc/proto-loader';

interface MessageTypeDefinition {
  serialize(message: Record<string, unknown>): Buffer;
  deserialize(buffer: Buffer): Record<string, unknown>;
}

const RAP_PROTO_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'realtime-activity-processing-service',
  'proto',
  'reward_ingest.proto',
);
const RR_PROTO_PATH = join(__dirname, '..', '..', 'proto', 'reward_ingest.proto');

const REWARD_ENTRY_MESSAGE_NAME = 'rewardrap.reward.v1.RewardEntry';

function loadRewardEntryType(protoPath: string): MessageTypeDefinition {
  const packageDefinition = protoLoader.loadSync(protoPath, {});
  const definition = packageDefinition[REWARD_ENTRY_MESSAGE_NAME] as unknown as
    MessageTypeDefinition | undefined;
  if (!definition) {
    throw new Error(`${REWARD_ENTRY_MESSAGE_NAME} not found in ${protoPath}`);
  }
  return definition;
}

describe('T-INT-058 TC-5 — RewardEntry proto wire parity (RAP encode -> RR decode)', () => {
  it('fields 26-28 (reward_kind/promo_code_config_id/promo_code_config_version_no) survive a real encode/decode round trip', () => {
    const rapType = loadRewardEntryType(RAP_PROTO_PATH);
    const rrType = loadRewardEntryType(RR_PROTO_PATH);

    const wireBytes = rapType.serialize({
      id: 'reward-entry-parity-1',
      correlationId: 'corr-parity-1',
      tenantId: 42,
      customerId: 'cust-parity-1',
      customerIdType: 'MSISDN',
      activityPerformedDate: '2026-09-12T10:00:00Z',
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
      rewardCode: 'RWD-PROMO-CODE',
      rewardCategory: 'PROMO',
      rewardValue: '0',
      rewardValueUnit: '',
      rewardEntryDate: '2026-09-12T10:00:03Z',
      completionCycle: 1,
      rewardKind: 'PROMO_CODE',
      promoCodeConfigId: 'PCC-CFG-001',
      promoCodeConfigVersionNo: 7,
    });

    const decoded = rrType.deserialize(wireBytes);

    expect(decoded).toMatchObject({
      id: 'reward-entry-parity-1',
      tenantId: 42,
      rewardKind: 'PROMO_CODE',
      promoCodeConfigId: 'PCC-CFG-001',
      promoCodeConfigVersionNo: 7,
    });
  });

  it('an old-shaped RAP-encoded message (fields 26-28 absent) decodes on RR side as undefined, never throwing', () => {
    const rapType = loadRewardEntryType(RAP_PROTO_PATH);
    const rrType = loadRewardEntryType(RR_PROTO_PATH);

    const wireBytes = rapType.serialize({
      id: 'reward-entry-parity-2',
      correlationId: 'corr-parity-2',
      tenantId: 7,
      customerId: 'cust-parity-2',
      customerIdType: 'MSISDN',
      activityPerformedDate: '2026-09-12T10:00:00Z',
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
      rewardEntryDate: '2026-09-12T10:00:03Z',
      completionCycle: 1,
      // reward_kind/promo_code_config_id/promo_code_config_version_no deliberately omitted.
    });

    const decoded = rrType.deserialize(wireBytes);

    // `@grpc/proto-loader`'s default (non-`defaults`) decode mode omits an absent scalar field
    // entirely rather than materializing proto3's own "zero value" convention — this is the exact
    // shape `RewardIngestController.toIngestDto` (`emptyToNull`/`parseRewardKind`) is written to
    // handle, confirmed by direct read of that adapter's own header comment.
    expect(decoded.rewardKind).toBeUndefined();
    expect(decoded.promoCodeConfigId).toBeUndefined();
    expect(decoded.promoCodeConfigVersionNo).toBeUndefined();
  });
});
