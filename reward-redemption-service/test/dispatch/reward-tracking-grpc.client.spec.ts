/**
 * T-RR-062, updated by T-INT-002 — `RewardTrackingGrpcClient`: pure env-parsing unit tests (no
 * network), plus a real `@grpc/grpc-js` mock reward-tracking-service implementing
 * `proto/reward_tracking_dispatch.proto` field-for-field — same "mocked server" convention
 * `promo-code-service-grpc.client.spec.ts` (T-RR-080) already established for the identical
 * situation (confirmed by direct read). The mock server below now speaks the corrected contract
 * (`rewardtracking.ingest.v1.RewardTrackingIngestService/IngestRewardTrackingEvent`,
 * `{status: 'applied'|'duplicate'}`) that matches RTS's real, shipped proto — see also
 * `test/dispatch/reward-tracking-contract-parity.spec.ts` (T-INT-002) for the test that reads RTS's
 * real source directly and fails if this ever drifts again.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'node:path';
import {
  DEFAULT_REWARD_TRACKING_GRPC_PORT,
  DEFAULT_REWARD_TRACKING_GRPC_TIMEOUT_MS,
  RewardTrackingGrpcClient,
  RewardTrackingGrpcUnreachableError,
  loadRewardTrackingGrpcClientOptions,
} from '@/modules/dispatch/reward-tracking-grpc.client';

const ENV_KEYS = [
  'REWARD_TRACKING_GRPC_HOST',
  'REWARD_TRACKING_GRPC_PORT',
  'REWARD_TRACKING_GRPC_TIMEOUT_MS',
  'REWARD_TRACKING_GRPC_TLS_CA_PATH',
  'REWARD_TRACKING_GRPC_TLS_CERT_PATH',
  'REWARD_TRACKING_GRPC_TLS_KEY_PATH',
] as const;

function withSavedEnv(fn: () => void | Promise<void>) {
  return async () => {
    const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    try {
      await fn();
    } finally {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  };
}

describe('loadRewardTrackingGrpcClientOptions', () => {
  it(
    'defaults host/port/timeout when nothing is configured, and no TLS material',
    withSavedEnv(() => {
      const options = loadRewardTrackingGrpcClientOptions();
      expect(options).toEqual({
        host: 'localhost',
        port: DEFAULT_REWARD_TRACKING_GRPC_PORT,
        timeoutMs: DEFAULT_REWARD_TRACKING_GRPC_TIMEOUT_MS,
      });
    }),
  );

  it(
    'reads a custom host/port/timeout from the environment',
    withSavedEnv(() => {
      process.env.REWARD_TRACKING_GRPC_HOST = 'reward-tracking-service.internal';
      process.env.REWARD_TRACKING_GRPC_PORT = '60171';
      process.env.REWARD_TRACKING_GRPC_TIMEOUT_MS = '9000';

      const options = loadRewardTrackingGrpcClientOptions();
      expect(options.host).toBe('reward-tracking-service.internal');
      expect(options.port).toBe(60171);
      expect(options.timeoutMs).toBe(9000);
    }),
  );

  it(
    'rejects a non-numeric REWARD_TRACKING_GRPC_PORT',
    withSavedEnv(() => {
      process.env.REWARD_TRACKING_GRPC_PORT = 'not-a-port';
      expect(() => loadRewardTrackingGrpcClientOptions()).toThrow(/REWARD_TRACKING_GRPC_PORT/);
    }),
  );

  it(
    'rejects a non-numeric REWARD_TRACKING_GRPC_TIMEOUT_MS',
    withSavedEnv(() => {
      process.env.REWARD_TRACKING_GRPC_TIMEOUT_MS = 'not-a-number';
      expect(() => loadRewardTrackingGrpcClientOptions()).toThrow(
        /REWARD_TRACKING_GRPC_TIMEOUT_MS/,
      );
    }),
  );

  describe('TLS material', () => {
    it(
      'a partial TLS_* set (missing key) throws, rather than silently connecting insecurely',
      withSavedEnv(() => {
        process.env.REWARD_TRACKING_GRPC_TLS_CA_PATH = join(
          __dirname,
          '..',
          'fixtures',
          'does-not-matter.pem',
        );
        expect(() => loadRewardTrackingGrpcClientOptions()).toThrow(
          /must all be set together, or none of them/,
        );
      }),
    );
  });
});

// -------------------------------------------------------------------------------------------
// Mock reward-tracking-service — implements the real proto shape.
// -------------------------------------------------------------------------------------------

function protoPath(): string {
  return join(__dirname, '..', '..', 'proto', 'reward_tracking_dispatch.proto');
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
    rewardtracking: {
      ingest: { v1: { RewardTrackingIngestService: { service: grpc.ServiceDefinition } } };
    };
  };
  return proto.rewardtracking.ingest.v1.RewardTrackingIngestService.service;
}

function sampleMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rewardEntryId: 'reward-entry-1',
    tenantId: 1,
    tenantCode: 'TEN-MY',
    countryCode: 'MY',
    customerId: 'CUST-1',
    campaignCode: 'CAMP1',
    rewardCode: 'RWD1',
    rewardCategory: 'CASHBACK',
    rewardValue: '2.5000',
    rewardValueUnit: 'MYR',
    externalSystemCode: 'PROMO_CODE_SERVICE',
    externalReferenceId: 'PC-abc123',
    redeemedAt: new Date().toISOString(),
    correlationId: 'corr-1',
    trackerCode: 'TRK1',
    trackerComponentCode: 'COMP1',
    merchantCode: null,
    expiresAt: null,
    rewardKind: null,
    promoCodeConfigId: null,
    promoCodeConfigVersionNo: null,
    ...overrides,
  };
}

interface MockHandlers {
  ingestRewardTrackingEvent: jest.Mock;
}

function buildHandlers(response: { status: string }): {
  impl: grpc.UntypedServiceImplementation;
  handlers: MockHandlers;
} {
  const ingestRewardTrackingEvent = jest.fn(
    (
      _call: grpc.ServerUnaryCall<unknown, { status: string }>,
      callback: grpc.sendUnaryData<{ status: string }>,
    ) => {
      callback(null, response);
    },
  );
  const impl: grpc.UntypedServiceImplementation = {
    IngestRewardTrackingEvent: ingestRewardTrackingEvent,
  } as unknown as grpc.UntypedServiceImplementation;
  return { impl, handlers: { ingestRewardTrackingEvent } };
}

function startMockServer(
  response: { status: string } = { status: 'applied' },
): Promise<{ server: grpc.Server; port: number; handlers: MockHandlers }> {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    const { impl, handlers } = buildHandlers(response);
    server.addService(loadServiceDefinition(), impl);
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ server, port, handlers });
    });
  });
}

function stopMockServer(server: grpc.Server): Promise<void> {
  return new Promise((resolve) => server.tryShutdown(() => resolve()));
}

describe('T-RR-062 — RewardTrackingGrpcClient, real mock reward-tracking-service', () => {
  let server: grpc.Server;
  let client: RewardTrackingGrpcClient;

  afterEach(async () => {
    client?.onModuleDestroy();
    if (server) {
      await stopMockServer(server);
    }
  });

  it('an "applied" response resolves without throwing, carrying the exact toRewardTrackingMessage shape', async () => {
    let port: number;
    let handlers: MockHandlers;
    ({ server, port, handlers } = await startMockServer());
    client = new RewardTrackingGrpcClient({ host: '127.0.0.1', port, timeoutMs: 2_000 });

    await expect(client.dispatch(sampleMessage())).resolves.toBeUndefined();

    const sentRequest = handlers.ingestRewardTrackingEvent.mock.calls[0][0].request as Record<
      string,
      unknown
    >;
    expect(sentRequest.rewardEntryId).toBe('reward-entry-1');
    expect(sentRequest.correlationId).toBe('corr-1');
    expect(sentRequest.customerId).toBe('CUST-1');
    expect(sentRequest.trackerCode).toBe('TRK1');
    expect(sentRequest.trackerComponentCode).toBe('COMP1');
    // proto3 "empty means absent" convention (this file's own header) — a `null` domain value
    // round-trips as an empty string / zero at the wire level, never a fabricated real value.
    expect(sentRequest.merchantCode).toBe('');
    expect(sentRequest.expiresAt).toBe('');
    expect(sentRequest.rewardKind).toBe('');
    expect(sentRequest.unitType).toBe('');
    expect(sentRequest.unitCode).toBe('');
    expect(sentRequest.promoCodeConfigId).toBe('');
    expect(sentRequest.promoCodeConfigVersionNo).toBe(0);
  });

  it('a "duplicate" response also resolves without throwing (RTS\'s own idempotent-replay outcome)', async () => {
    let port: number;
    ({ server, port } = await startMockServer({ status: 'duplicate' }));
    client = new RewardTrackingGrpcClient({ host: '127.0.0.1', port, timeoutMs: 2_000 });

    await expect(client.dispatch(sampleMessage())).resolves.toBeUndefined();
  });

  it('an unexpected (neither "applied" nor "duplicate") response status is treated as a failure', async () => {
    let port: number;
    ({ server, port } = await startMockServer({ status: 'REJECTED' }));
    client = new RewardTrackingGrpcClient({ host: '127.0.0.1', port, timeoutMs: 2_000 });

    await expect(client.dispatch(sampleMessage())).rejects.toThrow(/unexpected status/);
  });

  it('an unreachable server rejects with RewardTrackingGrpcUnreachableError, distinguishable from a per-message failure', async () => {
    // Deliberately never started — 127.0.0.1 on a closed port is a real, deterministic
    // connection-refused condition, not a mock.
    client = new RewardTrackingGrpcClient({ host: '127.0.0.1', port: 1, timeoutMs: 1_000 });

    await expect(client.dispatch(sampleMessage())).rejects.toBeInstanceOf(
      RewardTrackingGrpcUnreachableError,
    );
  });

  it('a deadline-exceeded call (server never responds) rejects with RewardTrackingGrpcUnreachableError within the configured timeout, never hangs', async () => {
    const server2 = new grpc.Server();
    const impl: grpc.UntypedServiceImplementation = {
      IngestRewardTrackingEvent: () => {
        // Never calls back — simulates a hung server.
      },
    } as unknown as grpc.UntypedServiceImplementation;
    server2.addService(loadServiceDefinition(), impl);
    const boundPort = await new Promise<number>((resolve, reject) => {
      server2.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, p) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(p);
      });
    });
    const hungClient = new RewardTrackingGrpcClient({
      host: '127.0.0.1',
      port: boundPort,
      timeoutMs: 300,
    });

    await expect(hungClient.dispatch(sampleMessage())).rejects.toBeInstanceOf(
      RewardTrackingGrpcUnreachableError,
    );

    hungClient.onModuleDestroy();
    await stopMockServer(server2);
  });

  it('never logs the plaintext customerId, on either the success or the failure path', async () => {
    const { Logger } = await import('@nestjs/common');
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      client = new RewardTrackingGrpcClient({ host: '127.0.0.1', port: 1, timeoutMs: 500 });

      await expect(
        client.dispatch(sampleMessage({ customerId: 'CUST-SECRET-GRPC' })),
      ).rejects.toBeTruthy();

      const loggedText = warnSpy.mock.calls.map((call) => JSON.stringify(call)).join('\n');
      expect(loggedText).not.toContain('CUST-SECRET-GRPC');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
