/**
 * T-RR-080 — `PromoCodeServiceGrpcClient`: pure env-parsing unit tests (no network), plus a real
 * `@grpc/grpc-js` mock promo-code-service implementing `proto/promo_code_generation.proto`
 * field-for-field (the same "mocked server" convention `campaign-config.client.spec.ts`, T-RR-022,
 * already established for the identical situation — confirmed by direct read).
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'node:path';
import {
  DEFAULT_PROMO_CODE_SERVICE_GRPC_PORT,
  DEFAULT_PROMO_CODE_SERVICE_GRPC_TIMEOUT_MS,
  PromoCodeServiceGrpcClient,
  loadPromoCodeServiceGrpcClientOptions,
} from '@/modules/connectors/promo-code-service-grpc.client';
import type {
  PromoCodeGenerateRequest,
  PromoCodeGenerateResponse,
} from '@/modules/connectors/promo-code-service.connector.types';

const ENV_KEYS = [
  'PROMO_CODE_SERVICE_GRPC_HOST',
  'PROMO_CODE_SERVICE_GRPC_PORT',
  'PROMO_CODE_SERVICE_GRPC_TIMEOUT_MS',
  'PROMO_CODE_SERVICE_GRPC_TLS_CA_PATH',
  'PROMO_CODE_SERVICE_GRPC_TLS_CERT_PATH',
  'PROMO_CODE_SERVICE_GRPC_TLS_KEY_PATH',
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

describe('loadPromoCodeServiceGrpcClientOptions', () => {
  it(
    'defaults host/port/timeout when nothing is configured, and no TLS material',
    withSavedEnv(() => {
      const options = loadPromoCodeServiceGrpcClientOptions();
      expect(options).toEqual({
        host: 'localhost',
        port: DEFAULT_PROMO_CODE_SERVICE_GRPC_PORT,
        timeoutMs: DEFAULT_PROMO_CODE_SERVICE_GRPC_TIMEOUT_MS,
      });
    }),
  );

  it(
    'reads a custom host/port/timeout from the environment',
    withSavedEnv(() => {
      process.env.PROMO_CODE_SERVICE_GRPC_HOST = 'promo-code-service.internal';
      process.env.PROMO_CODE_SERVICE_GRPC_PORT = '60161';
      process.env.PROMO_CODE_SERVICE_GRPC_TIMEOUT_MS = '9000';

      const options = loadPromoCodeServiceGrpcClientOptions();
      expect(options.host).toBe('promo-code-service.internal');
      expect(options.port).toBe(60161);
      expect(options.timeoutMs).toBe(9000);
    }),
  );

  it(
    'rejects a non-numeric PROMO_CODE_SERVICE_GRPC_PORT',
    withSavedEnv(() => {
      process.env.PROMO_CODE_SERVICE_GRPC_PORT = 'not-a-port';
      expect(() => loadPromoCodeServiceGrpcClientOptions()).toThrow(/PROMO_CODE_SERVICE_GRPC_PORT/);
    }),
  );

  it(
    'rejects a non-numeric PROMO_CODE_SERVICE_GRPC_TIMEOUT_MS',
    withSavedEnv(() => {
      process.env.PROMO_CODE_SERVICE_GRPC_TIMEOUT_MS = 'not-a-number';
      expect(() => loadPromoCodeServiceGrpcClientOptions()).toThrow(
        /PROMO_CODE_SERVICE_GRPC_TIMEOUT_MS/,
      );
    }),
  );

  describe('TLS material', () => {
    const fixturesDir = join(__dirname, '..', 'fixtures');

    it(
      'a partial TLS_* set (missing key) throws, rather than silently connecting insecurely',
      withSavedEnv(() => {
        process.env.PROMO_CODE_SERVICE_GRPC_TLS_CA_PATH = join(fixturesDir, 'does-not-matter.pem');
        expect(() => loadPromoCodeServiceGrpcClientOptions()).toThrow(
          /must all be set together, or none of them/,
        );
      }),
    );
  });
});

// -------------------------------------------------------------------------------------------
// Mock promo-code-service — implements the real proto shape.
// -------------------------------------------------------------------------------------------

function protoPath(): string {
  return join(__dirname, '..', '..', 'proto', 'promo_code_generation.proto');
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
    promocode: { v1: { PromoCodeService: { service: grpc.ServiceDefinition } } };
  };
  return proto.promocode.v1.PromoCodeService.service;
}

function successResponse(
  overrides: Partial<PromoCodeGenerateResponse> = {},
): PromoCodeGenerateResponse {
  return {
    status: 'SUCCESS',
    promoCodeId: 'grpc-promo-code-id-1',
    code: 'WELCOME10-GRPC1',
    rewardValueType: 'PERCENTAGE',
    rewardValue: '10.0000',
    rewardUnit: '%',
    expiresAt: '',
    errorCode: '',
    errorMessage: '',
    // T-RR-090: this is the raw proto message the mock server hands back (not yet through the
    // client's own null-translation) — proto3's own default for an unset string, same convention
    // every other field on this fixture already uses.
    versionNo: '',
    ...overrides,
  };
}

function failedResponse(errorCode: string, errorMessage = 'boom'): PromoCodeGenerateResponse {
  return {
    status: 'FAILED',
    promoCodeId: '',
    code: '',
    rewardValueType: '',
    rewardValue: '',
    rewardUnit: '',
    expiresAt: '',
    errorCode,
    errorMessage,
    // T-RR-090.
    versionNo: '',
  };
}

function sampleRequest(
  overrides: Partial<PromoCodeGenerateRequest> = {},
): PromoCodeGenerateRequest {
  return {
    correlationId: 'corr-1',
    tenantId: '1',
    bindLevel: 'CAMPAIGN',
    bindRefId: 'CAMP1',
    customerId: 'customer-1',
    merchantId: '',
    // T-RR-090.
    versionNo: null,
    activityContext: { amount: '50.0000', currency: 'MYR', metadataJson: '{}' },
    ...overrides,
  };
}

interface MockPromoCodeServiceHandlers {
  generateCode: jest.Mock;
}

function buildHandlers(response: PromoCodeGenerateResponse): {
  impl: grpc.UntypedServiceImplementation;
  handlers: MockPromoCodeServiceHandlers;
} {
  const generateCode = jest.fn(
    (
      _call: grpc.ServerUnaryCall<unknown, PromoCodeGenerateResponse>,
      callback: grpc.sendUnaryData<PromoCodeGenerateResponse>,
    ) => {
      callback(null, response);
    },
  );

  const impl: grpc.UntypedServiceImplementation = {
    generateCode,
    listActivePromoCodeConfigs: (_call: unknown, callback: grpc.sendUnaryData<unknown>) => {
      callback({ name: 'Unimplemented', message: 'not used', code: grpc.status.UNIMPLEMENTED });
    },
  } as unknown as grpc.UntypedServiceImplementation;

  return { impl, handlers: { generateCode } };
}

function startMockServer(
  response: PromoCodeGenerateResponse,
): Promise<{ server: grpc.Server; port: number; handlers: MockPromoCodeServiceHandlers }> {
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

describe('T-RR-080 — PromoCodeServiceGrpcClient, real mock promo-code-service', () => {
  let server: grpc.Server;
  let port: number;
  let handlers: MockPromoCodeServiceHandlers;
  let client: PromoCodeServiceGrpcClient;

  afterEach(async () => {
    client?.onModuleDestroy();
    if (server) {
      await stopMockServer(server);
    }
  });

  it('TC-A: a SUCCESS response round-trips the real proto shape field-for-field', async () => {
    ({ server, port, handlers } = await startMockServer(successResponse()));
    client = new PromoCodeServiceGrpcClient({ host: '127.0.0.1', port, timeoutMs: 2_000 });

    const response = await client.generateCode(sampleRequest());

    expect(response).toMatchObject({
      status: 'SUCCESS',
      promoCodeId: 'grpc-promo-code-id-1',
      code: 'WELCOME10-GRPC1',
      rewardValueType: 'PERCENTAGE',
      rewardValue: '10.0000',
      rewardUnit: '%',
    });
    const sentRequest = handlers.generateCode.mock.calls[0][0].request as PromoCodeGenerateRequest;
    expect(sentRequest.correlationId).toBe('corr-1');
    expect(sentRequest.activityContext.amount).toBe('50.0000');
  });

  it("TC-B (TC-5 parity): a FAILED response round-trips its errorCode/errorMessage untouched — classification is the caller's own job, not this client's", async () => {
    ({ server, port } = await startMockServer(
      failedResponse('CONFIG_INACTIVE', 'binding inactive'),
    ));
    client = new PromoCodeServiceGrpcClient({ host: '127.0.0.1', port, timeoutMs: 2_000 });

    const response = await client.generateCode(sampleRequest());

    expect(response.status).toBe('FAILED');
    expect(response.errorCode).toBe('CONFIG_INACTIVE');
    expect(response.errorMessage).toBe('binding inactive');
  });

  it('TC-C (TC-4 parity): an unreachable server rejects — the caller decides this is a transport failure, this client never swallows it', async () => {
    // Deliberately never started — 127.0.0.1 on a closed port is a real, deterministic
    // connection-refused condition, not a mock.
    client = new PromoCodeServiceGrpcClient({ host: '127.0.0.1', port: 1, timeoutMs: 1_000 });

    await expect(client.generateCode(sampleRequest())).rejects.toBeTruthy();
  });

  it('a deadline-exceeded call (server never responds) rejects within the configured timeout, never hangs', async () => {
    const server2 = new grpc.Server();
    const impl: grpc.UntypedServiceImplementation = {
      generateCode: () => {
        // Never calls back — simulates a hung server.
      },
      listActivePromoCodeConfigs: (_call: unknown, callback: grpc.sendUnaryData<unknown>) => {
        callback({ name: 'Unimplemented', message: 'not used', code: grpc.status.UNIMPLEMENTED });
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
    const hungClient = new PromoCodeServiceGrpcClient({
      host: '127.0.0.1',
      port: boundPort,
      timeoutMs: 300,
    });

    await expect(hungClient.generateCode(sampleRequest())).rejects.toBeTruthy();

    hungClient.onModuleDestroy();
    await stopMockServer(server2);
  });
});
