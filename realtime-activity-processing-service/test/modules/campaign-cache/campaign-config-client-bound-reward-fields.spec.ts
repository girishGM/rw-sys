/**
 * T-RAP-065. Regression coverage for the defect T-RAP-062 reproduced: this service's own
 * client-side mirror of the portal's `BoundReward` message (`proto/campaign_config.proto`) and
 * the `BoundRewardProto` TS interface (`campaign-config.client.ts`) were missing the fields T-173
 * added on the portal side — `expiry_value`/`expiry_unit` (13/14) and, critically for T-RAP-062,
 * `reward_kind`/`promo_code_config_id`/`promo_code_config_version_no` (15/16/17).
 *
 * This spins up a real `@grpc/grpc-js` mock server implementing the real proto shape (same
 * pattern `campaign-config-cache.e2e-spec.ts` already established) and round-trips a
 * `CampaignConfig` whose one `BoundReward` sets every field 1-17. No Postgres needed — this test
 * only exercises the wire-level (de)serialization `protoLoader.loadSync` + `@grpc/grpc-js`
 * perform against `proto/campaign_config.proto`, which is exactly what a missing field number
 * silently drops (proto3 tolerates unknown fields by discarding them, not by erroring).
 *
 * **TC-3 (the regression test) was proven red on the pre-fix proto**: run against the proto as it
 * stood before this task (fields 1-12 only on `BoundReward`), the mock server discards
 * `expiryValue`/`expiryUnit`/`rewardKind`/`promoCodeConfigId`/`promoCodeConfigVersionNo` during
 * serialization (they aren't in the wire schema), so the client received `undefined` for all
 * five, and `BoundRewardProto` didn't even have those properties to type-check against. Reverting
 * `proto/campaign_config.proto`'s `BoundReward` message to fields 1-12 only reproduces that
 * failure again (confirmed manually as part of this task's diagnosis).
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'node:path';
import { CampaignConfigClient } from '@/modules/campaign-cache/campaign-config.client';
import type {
  BoundRewardProto,
  CampaignConfigProto,
} from '@/modules/campaign-cache/campaign-config.client';

function protoPath(): string {
  return join(__dirname, '..', '..', '..', 'proto', 'campaign_config.proto');
}

function loadServiceDefinition(): grpc.ServiceDefinition {
  const packageDefinition = protoLoader.loadSync(protoPath(), {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    rewardportal: {
      config: { v1: { CampaignConfigService: { service: grpc.ServiceDefinition } } };
    };
  };
  return proto.rewardportal.config.v1.CampaignConfigService.service;
}

function unimplemented(callback: grpc.sendUnaryData<unknown>): void {
  callback({
    name: 'Unimplemented',
    message: 'not used by this test',
    code: grpc.status.UNIMPLEMENTED,
  });
}

/** Every field 1-17 of `BoundReward` set to a distinguishable, non-default value, so a field
 * silently dropping to its zero value on the wire is unambiguously detectable. */
const FULL_BOUND_REWARD: Required<BoundRewardProto> = {
  rewardId: 501,
  rewardVersionId: 5001,
  versionNo: 3,
  systemCode: 'CASHBACK_5',
  rewardType: 'CASHBACK',
  deliveryMode: 'AUTO',
  policiesJson: '{"rate":5}',
  unitType: 'currency',
  unitCode: 'MYR',
  level: 'tracker',
  refId: 100,
  status: 'active',
  expiryValue: 30,
  expiryUnit: 'days',
  rewardKind: 'PERCENTAGE',
  promoCodeConfigId: 'pc-cfg-77',
  promoCodeConfigVersionNo: 4,
};

function buildCampaign(tenantId: number): CampaignConfigProto {
  return {
    campaignId: 1,
    campaignCode: 'CAMP1',
    tenantId,
    countryId: 1,
    status: 'active',
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: '2026-12-31T00:00:00.000Z',
    budget: { amount: '1000.00', currency: 'USD' },
    maxParticipants: 100,
    merchants: [],
    trackers: [],
    rules: [],
    rewards: [FULL_BOUND_REWARD],
    etag: 'etag-1',
    configHash: 'hash-1',
    notModified: false,
    servedAt: new Date().toISOString(),
    caps: [],
    sectionsReturned: ['REWARDS'],
    sectionsOmitted: [],
  };
}

function buildHandlers(campaign: CampaignConfigProto): grpc.UntypedServiceImplementation {
  return {
    listActiveCampaigns: (
      _call: unknown,
      callback: grpc.sendUnaryData<{
        campaigns: CampaignConfigProto[];
        servedAt: string;
        sectionsReturned: string[];
        sectionsOmitted: string[];
      }>,
    ) => {
      callback(null, {
        campaigns: [campaign],
        servedAt: new Date().toISOString(),
        sectionsReturned: [],
        sectionsOmitted: [],
      });
    },
    getCampaignConfig: (_call: unknown, callback: grpc.sendUnaryData<CampaignConfigProto>) => {
      callback(null, campaign);
    },
    watchCampaignConfig: (call: grpc.ServerWritableStream<unknown, unknown>) => {
      call.on('cancelled', () => call.end());
    },
    resolveRuleVersion: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
      unimplemented(callback),
    resolveRewardVersion: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
      unimplemented(callback),
    getBudgetStatus: (_call: unknown, callback: grpc.sendUnaryData<unknown>) =>
      unimplemented(callback),
  } as unknown as grpc.UntypedServiceImplementation;
}

function startMockServer(
  campaign: CampaignConfigProto,
): Promise<{ server: grpc.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(loadServiceDefinition(), buildHandlers(campaign));
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ server, port });
    });
  });
}

function stopMockServer(server: grpc.Server): Promise<void> {
  return new Promise((resolve) => server.tryShutdown(() => resolve()));
}

describe('T-RAP-065 — BoundReward wire mirror carries T-173 fields 13-17', () => {
  let server: grpc.Server;
  let client: CampaignConfigClient;

  beforeAll(async () => {
    const { server: s, port } = await startMockServer(buildCampaign(42));
    server = s;
    client = new CampaignConfigClient({ host: '127.0.0.1', port, timeoutMs: 5000 });
  });

  afterAll(async () => {
    await client.onModuleDestroy();
    await stopMockServer(server);
  });

  it('TC-1/TC-2/TC-3: round-trips reward_kind/promo_code_config_id/promo_code_config_version_no (and expiry) unchanged', async () => {
    const config = await client.getCampaignConfig(42, 'CAMP1', ['REWARDS']);
    expect(config.rewards).toHaveLength(1);
    const reward = config.rewards[0] as Required<BoundRewardProto>;

    // TC-4: adjacent, pre-existing fields (1-12) must remain unchanged by this task.
    expect(reward.rewardId).toBe(501);
    expect(reward.rewardVersionId).toBe(5001);
    expect(reward.versionNo).toBe(3);
    expect(reward.systemCode).toBe('CASHBACK_5');
    expect(reward.rewardType).toBe('CASHBACK');
    expect(reward.deliveryMode).toBe('AUTO');
    expect(reward.policiesJson).toBe('{"rate":5}');
    expect(reward.unitType).toBe('currency');
    expect(reward.unitCode).toBe('MYR');
    expect(reward.level).toBe('tracker');
    expect(reward.refId).toBe(100);
    expect(reward.status).toBe('active');

    // The fields this task adds — this is the assertion that fails on the pre-fix proto/interface.
    expect(reward.expiryValue).toBe(30);
    expect(reward.expiryUnit).toBe('days');
    expect(reward.rewardKind).toBe('PERCENTAGE');
    expect(reward.promoCodeConfigId).toBe('pc-cfg-77');
    expect(reward.promoCodeConfigVersionNo).toBe(4);
  });

  it('TC-2: empty/zero values on the new fields round-trip as empty/zero, never fabricated', async () => {
    const emptyReward: BoundRewardProto = {
      rewardId: 502,
      rewardVersionId: 5002,
      versionNo: 1,
      systemCode: 'PLAIN',
      rewardType: 'FIXED',
      deliveryMode: 'AUTO',
      policiesJson: '{}',
      unitType: 'currency',
      unitCode: 'MYR',
      level: 'campaign',
      refId: 0,
      status: 'active',
    };
    const campaign = buildCampaign(43);
    campaign.rewards = [emptyReward];
    const { server: s, port } = await startMockServer(campaign);
    const c = new CampaignConfigClient({ host: '127.0.0.1', port, timeoutMs: 5000 });
    try {
      const config = await c.getCampaignConfig(43, 'CAMP1', ['REWARDS']);
      const reward = config.rewards[0] as Required<BoundRewardProto>;
      expect(reward.rewardKind).toBe('');
      expect(reward.promoCodeConfigId).toBe('');
      expect(reward.promoCodeConfigVersionNo).toBe(0);
      expect(reward.expiryValue).toBe(0);
      expect(reward.expiryUnit).toBe('');
    } finally {
      await c.onModuleDestroy();
      await stopMockServer(s);
    }
  });
});
