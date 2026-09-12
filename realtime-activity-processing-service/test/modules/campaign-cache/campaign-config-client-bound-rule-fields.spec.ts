/**
 * T-RAP-066. Regression coverage for the defect T-RAP-064 reproduced (but could not fix — the
 * affected files are outside its own scope): this service's own client-side mirror of the
 * portal's `BoundRule` message (`proto/campaign_config.proto`) and the `BoundRuleProto` TS
 * interface (`campaign-config.client.ts`) were missing the fields T-175 added on the portal side —
 * `operator`/`resolver_id`/`resolver_config`/`default_operators` (10/11/12/13).
 *
 * This spins up a real `@grpc/grpc-js` mock server implementing the real proto shape (same
 * pattern `campaign-config-client-bound-reward-fields.spec.ts` (T-RAP-065) already established)
 * and round-trips a `CampaignConfig` whose one `BoundRule` sets every field 1-13. No Postgres
 * needed — this test only exercises the wire-level (de)serialization `protoLoader.loadSync` +
 * `@grpc/grpc-js` perform against `proto/campaign_config.proto`, which is exactly what a missing
 * field number silently drops (proto3 tolerates unknown fields by discarding them, not by
 * erroring).
 *
 * **TC-3 (the regression test) was proven red on the pre-fix proto**: run against the proto as it
 * stood before this task (fields 1-9 only on `BoundRule`), the mock server discards
 * `operator`/`resolverId`/`resolverConfig`/`defaultOperators` during serialization (they aren't in
 * the wire schema), so the client received `undefined` for all four, and `BoundRuleProto` didn't
 * even have those properties to type-check against. Reverting `proto/campaign_config.proto`'s
 * `BoundRule` message to fields 1-9 only reproduces that failure again (confirmed manually as part
 * of this task's diagnosis).
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'node:path';
import { CampaignConfigClient } from '@/modules/campaign-cache/campaign-config.client';
import type {
  BoundRuleProto,
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

/** Every field 1-13 of `BoundRule` set to a distinguishable, non-default value, so a field
 * silently dropping to its zero value on the wire is unambiguously detectable. */
const FULL_BOUND_RULE: Required<BoundRuleProto> = {
  ruleId: 701,
  ruleVersionId: 7001,
  versionNo: 2,
  ruleCode: 'RULE_ACTIVITY_WINDOW_001',
  expression: 'activity.value :operator :value within :windowType',
  parametersJson: '{"value":{"type":"number"}}',
  boundValuesJson: '{"value":100}',
  trackerComponentId: 55,
  status: 'active',
  operator: 'GTE',
  resolverId: 5,
  resolverConfig: '{"windowType":"CALENDAR_MONTH"}',
  defaultOperators: ['GTE', 'GT'],
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
    rules: [FULL_BOUND_RULE],
    rewards: [],
    etag: 'etag-1',
    configHash: 'hash-1',
    notModified: false,
    servedAt: new Date().toISOString(),
    caps: [],
    sectionsReturned: ['RULES'],
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

describe('T-RAP-066 — BoundRule wire mirror carries T-175 fields 10-13', () => {
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

  it('TC-1/TC-2/TC-3: round-trips operator/resolverId/resolverConfig/defaultOperators unchanged', async () => {
    const config = await client.getCampaignConfig(42, 'CAMP1', ['RULES']);
    expect(config.rules).toHaveLength(1);
    const rule = config.rules[0] as Required<BoundRuleProto>;

    // TC-4: adjacent, pre-existing fields (1-9) must remain unchanged by this task.
    expect(rule.ruleId).toBe(701);
    expect(rule.ruleVersionId).toBe(7001);
    expect(rule.versionNo).toBe(2);
    expect(rule.ruleCode).toBe('RULE_ACTIVITY_WINDOW_001');
    expect(rule.expression).toBe('activity.value :operator :value within :windowType');
    expect(rule.parametersJson).toBe('{"value":{"type":"number"}}');
    expect(rule.boundValuesJson).toBe('{"value":100}');
    expect(rule.trackerComponentId).toBe(55);
    expect(rule.status).toBe('active');

    // The fields this task adds — this is the assertion that fails on the pre-fix proto/interface.
    expect(rule.operator).toBe('GTE');
    expect(rule.resolverId).toBe(5);
    expect(rule.resolverConfig).toBe('{"windowType":"CALENDAR_MONTH"}');
    expect(rule.defaultOperators).toEqual(['GTE', 'GT']);
  });

  it('TC-2: empty/zero values on the new fields round-trip as empty/zero, never fabricated', async () => {
    const emptyRule: BoundRuleProto = {
      ruleId: 702,
      ruleVersionId: 0,
      versionNo: 0,
      ruleCode: 'RULE_NO_RESOLVER',
      expression: 'activity.count > 0',
      parametersJson: '{}',
      boundValuesJson: '{}',
      trackerComponentId: 56,
      status: 'active',
    };
    const campaign = buildCampaign(43);
    campaign.rules = [emptyRule];
    const { server: s, port } = await startMockServer(campaign);
    const c = new CampaignConfigClient({ host: '127.0.0.1', port, timeoutMs: 5000 });
    try {
      const config = await c.getCampaignConfig(43, 'CAMP1', ['RULES']);
      const rule = config.rules[0] as Required<BoundRuleProto>;
      expect(rule.operator).toBe('');
      expect(rule.resolverId).toBe(0);
      expect(rule.resolverConfig).toBe('');
      expect(rule.defaultOperators).toEqual([]);
    } finally {
      await c.onModuleDestroy();
      await stopMockServer(s);
    }
  });
});
