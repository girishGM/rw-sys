/**
 * T-RAP-034. Real, wire-level coverage of `RewardGrpcFallbackClient` — no fake standing in for
 * gRPC (`outbox-publisher.spec.ts`/`reward-dispatch-retry.worker.spec.ts` already cover the
 * orchestration side against a fake of this client; this file covers what that fake stands in
 * for), same "two mock servers ... a real @grpc/grpc-js mock" precedent
 * `budget-breach-callback.spec.ts` (T-RAP-033) already established for this project.
 *
 * `reward-redemption-service` does not exist anywhere in this repo (`03-GRPC-CONTRACT.md` §3) —
 * this mock server plays that role, loaded from this task's own `proto/reward_ingest.proto`.
 */
import 'reflect-metadata';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
  RewardGrpcFallbackClient,
  type RewardEntryGrpcPayload,
} from '@/modules/dispatch/reward-grpc-fallback.client';

function protoPath(): string {
  return join(__dirname, '..', '..', '..', 'proto', 'reward_ingest.proto');
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
    rewardrap: { reward: { v1: { RewardIngestService: { service: grpc.ServiceDefinition } } } };
  };
  return proto.rewardrap.reward.v1.RewardIngestService.service;
}

type SubmitHandler = (
  request: RewardEntryGrpcPayload,
) => { rewardEntryId: string; status: string } | { error: grpc.ServiceError };

function startGrpcMock(handler: SubmitHandler): Promise<{ server: grpc.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(loadServiceDefinition(), {
      submitRewardEntry: (
        call: grpc.ServerUnaryCall<
          RewardEntryGrpcPayload,
          { rewardEntryId: string; status: string }
        >,
        callback: grpc.sendUnaryData<{ rewardEntryId: string; status: string }>,
      ) => {
        const outcome = handler(call.request);
        if ('error' in outcome) {
          callback(outcome.error, null);
          return;
        }
        callback(null, outcome);
      },
    } as unknown as grpc.UntypedServiceImplementation);
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ server, port });
    });
  });
}

function stopGrpcMock(server: grpc.Server): void {
  server.forceShutdown();
}

function samplePayload(overrides: Partial<RewardEntryGrpcPayload> = {}): RewardEntryGrpcPayload {
  return {
    id: 'reward-entry-1',
    correlationId: 'corr-1',
    tenantId: 1,
    customerId: 'CUST-1',
    customerIdType: 'INTERNAL_ID',
    activityPerformedDate: new Date().toISOString(),
    transactionType: '',
    activityCode: 'PURCHASE',
    activityType: 'TRANSACTION',
    activityCategory: 'RETAIL',
    activityValue: '10.0000',
    activityValueUnit: 'MYR',
    channel: 'WEB',
    activityPerformedEnv: 'PROD',
    activityName: 'Online purchase',
    campaignCode: 'CAMP1',
    trackerCode: 'TRK1',
    trackerComponentCode: 'COMP1',
    merchantCode: '',
    rewardCode: 'RWD1',
    rewardCategory: 'cashback',
    rewardValue: '10.00',
    rewardValueUnit: 'MYR',
    rewardEntryDate: new Date().toISOString(),
    completionCycle: 1,
    ...overrides,
  };
}

describe('RewardGrpcFallbackClient (real @grpc/grpc-js wire, insecure mock server)', () => {
  it('submitRewardEntry resolves with the mock server’s own ack on success', async () => {
    const requests: RewardEntryGrpcPayload[] = [];
    const { server, port } = await startGrpcMock((request) => {
      requests.push(request);
      return { rewardEntryId: request.id, status: 'accepted' };
    });
    const client = new RewardGrpcFallbackClient({ host: '127.0.0.1', port, timeoutMs: 3000 });

    try {
      const ack = await client.submitRewardEntry(samplePayload({ id: 'reward-entry-xyz' }));
      expect(ack).toEqual({ rewardEntryId: 'reward-entry-xyz', status: 'accepted' });
      expect(requests).toHaveLength(1);
      expect(requests[0].customerId).toBe('CUST-1');
      expect(requests[0].rewardCode).toBe('RWD1');
    } finally {
      client.onModuleDestroy();
      stopGrpcMock(server);
    }
  });

  it('submitRewardEntry rejects when the server returns an error status', async () => {
    const { server, port } = await startGrpcMock(() => ({
      error: {
        code: grpc.status.INTERNAL,
        message: 'redemption ledger unavailable',
      } as grpc.ServiceError,
    }));
    const client = new RewardGrpcFallbackClient({ host: '127.0.0.1', port, timeoutMs: 3000 });

    try {
      await expect(client.submitRewardEntry(samplePayload())).rejects.toThrow(
        /redemption ledger unavailable/,
      );
    } finally {
      client.onModuleDestroy();
      stopGrpcMock(server);
    }
  });

  it('submitRewardEntry rejects (rather than hangs) when nothing is listening on the target port', async () => {
    // No server bound — `reward-redemption-service`'s own non-existence status
    // (`03-GRPC-CONTRACT.md` §3: "expected to fail closed ... in any environment where
    // reward-redemption-service isn't actually running").
    const client = new RewardGrpcFallbackClient({ host: '127.0.0.1', port: 1, timeoutMs: 800 });
    try {
      await expect(client.submitRewardEntry(samplePayload())).rejects.toThrow();
    } finally {
      client.onModuleDestroy();
    }
  });

  it('loadRewardGrpcFallbackClientOptions rejects a partial TLS configuration', async () => {
    const previous = {
      ca: process.env.REWARD_REDEMPTION_GRPC_TLS_CA_PATH,
      cert: process.env.REWARD_REDEMPTION_GRPC_TLS_CERT_PATH,
      key: process.env.REWARD_REDEMPTION_GRPC_TLS_KEY_PATH,
    };
    process.env.REWARD_REDEMPTION_GRPC_TLS_CA_PATH = '/tmp/ca.pem';
    delete process.env.REWARD_REDEMPTION_GRPC_TLS_CERT_PATH;
    delete process.env.REWARD_REDEMPTION_GRPC_TLS_KEY_PATH;
    try {
      const { loadRewardGrpcFallbackClientOptions } =
        await import('@/modules/dispatch/reward-grpc-fallback.client');
      expect(() => loadRewardGrpcFallbackClientOptions()).toThrow(/must all be set together/);
    } finally {
      if (previous.ca === undefined) {
        delete process.env.REWARD_REDEMPTION_GRPC_TLS_CA_PATH;
      } else {
        process.env.REWARD_REDEMPTION_GRPC_TLS_CA_PATH = previous.ca;
      }
      if (previous.cert !== undefined) {
        process.env.REWARD_REDEMPTION_GRPC_TLS_CERT_PATH = previous.cert;
      }
      if (previous.key !== undefined) {
        process.env.REWARD_REDEMPTION_GRPC_TLS_KEY_PATH = previous.key;
      }
    }
  });
});
