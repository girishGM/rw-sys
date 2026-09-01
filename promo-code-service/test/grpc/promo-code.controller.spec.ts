/**
 * T-PC-031. Fast, mocked-dependency unit tests for `MtlsGuard` and `PromoCodeController`, plus
 * the static, file-content checks the task file's own TC-10/TC-11/TC-12 describe as "code
 * inspection"/`grep` verification steps — kept here as real, automated regression tests (not just
 * a one-off command run once at review time) so a future change that reintroduces business logic
 * into this transport adapter, or drifts a money field off `string`, fails CI immediately.
 *
 * The real-mTLS/real-Postgres round trip (TC-1..TC-9, TC-13..TC-16) lives in
 * `grpc-server.e2e-spec.ts` instead — same split `promo-code-config.controller.spec.ts`/
 * `promo-code-config.e2e-spec.ts` (T-PC-011) already established for this project.
 *
 * Deviation from the task file's literal path (`test/modules/grpc-server/promo-code.controller.spec.ts`):
 * `project.config.json` grants this agent `test/grpc/**`, not `test/modules/grpc-server/**` (same
 * class of deviation `internal-service-token.guard.ts`'s own header documents for T-PC-011) — see
 * this task's completion report's "Deviations from spec".
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { MtlsGuard } from '@/grpc/mtls.guard';
import type { ServiceIdentityRepository } from '@/grpc/service-identity.repository';
import { PromoCodeController } from '@/grpc/promo-code.controller';
import type { PromoCodeGenerationService } from '@/modules/generation/promo-code-generation.service';
import type { PromoCodeConfigRepository } from '@/modules/promo-code-config/promo-code-config.repository';
import type { GenerationResult } from '@/modules/generation/generation-result.types';
import type { PromoCodeConfig } from '@/modules/promo-code-config/promo-code-config.entity';

const PROTO_PATH = join(__dirname, '..', '..', 'proto', 'promo_code.v1.proto');
const CONTROLLER_SOURCE_PATH = join(
  __dirname,
  '..',
  '..',
  'src',
  'grpc',
  'promo-code.controller.ts',
);

function fakeContextWithCall(call: unknown): ExecutionContext {
  return {
    getArgByIndex: () => call,
  } as unknown as ExecutionContext;
}

function authContextCall(
  peerCertificate: {
    subjectaltname?: string;
    subject?: Record<string, string>;
  } | null,
): unknown {
  return {
    getAuthContext: () => ({
      transportSecurityType: peerCertificate ? 'ssl' : undefined,
      sslPeerCertificate: peerCertificate ?? undefined,
    }),
  };
}

describe('T-PC-031 — MtlsGuard (unit, mocked repository)', () => {
  function buildGuard(match: string | null): { guard: MtlsGuard; repo: ServiceIdentityRepository } {
    const repo = {
      findFirstActiveMatch: jest.fn().mockResolvedValue(match),
    } as unknown as ServiceIdentityRepository;
    return { guard: new MtlsGuard(repo), repo };
  }

  it('rejects (UNAUTHENTICATED) when the call context exposes no getAuthContext at all', async () => {
    const { guard } = buildGuard(null);
    const context = fakeContextWithCall({});

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.UNAUTHENTICATED }),
    });
  });

  it('rejects (UNAUTHENTICATED) when no peer certificate is present', async () => {
    const { guard } = buildGuard(null);
    const context = fakeContextWithCall(authContextCall(null));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(RpcException);
  });

  it('rejects (PERMISSION_DENIED) when the SAN has no active allowlist match', async () => {
    const { guard, repo } = buildGuard(null);
    const context = fakeContextWithCall(
      authContextCall({ subjectaltname: 'DNS:some-other-service' }),
    );

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.PERMISSION_DENIED }),
    });
    expect(repo.findFirstActiveMatch).toHaveBeenCalledWith(['some-other-service']);
  });

  it('allows the call through when the SAN matches an active allowlist row', async () => {
    const { guard } = buildGuard('reward-redemption-service');
    const context = fakeContextWithCall(
      authContextCall({ subjectaltname: 'DNS:reward-redemption-service, DNS:extra' }),
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('falls back to the certificate CN when no SAN is present', async () => {
    const { guard, repo } = buildGuard('cn-identity');
    const context = fakeContextWithCall(authContextCall({ subject: { CN: 'cn-identity' } }));

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(repo.findFirstActiveMatch).toHaveBeenCalledWith(['cn-identity']);
  });
});

describe('T-PC-031 — PromoCodeController (unit, mocked generation service/repository)', () => {
  function buildController(
    generateCode: jest.Mock,
    list: jest.Mock = jest.fn().mockResolvedValue([]),
  ): PromoCodeController {
    const generationService = { generateCode } as unknown as PromoCodeGenerationService;
    const repository = { list } as unknown as PromoCodeConfigRepository;
    return new PromoCodeController(generationService, repository);
  }

  const successResult: GenerationResult = {
    status: 'SUCCESS',
    promoCodeId: 'pc-1',
    code: 'ABC123',
    rewardValueType: 'FIXED_AMOUNT',
    rewardValue: '10.0000',
    rewardUnit: 'USD',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    errorCode: null,
    errorMessage: null,
  };

  it('maps a SUCCESS GenerationResult onto GenerateCodeResponse, ISO-formatting expiresAt', async () => {
    const generateCode = jest.fn().mockResolvedValue(successResult);
    const controller = buildController(generateCode);

    const response = await controller.generateCode({
      correlationId: 'corr-1',
      tenantId: 'tenant-1',
      bindLevel: 'CAMPAIGN',
      bindRefId: 'ref-1',
      customerId: 'cust-1',
      merchantId: '',
    });

    expect(response).toEqual({
      status: 'SUCCESS',
      promoCodeId: 'pc-1',
      code: 'ABC123',
      rewardValueType: 'FIXED_AMOUNT',
      rewardValue: '10.0000',
      rewardUnit: 'USD',
      expiresAt: '2030-01-01T00:00:00.000Z',
      errorCode: '',
      errorMessage: '',
    });
    expect(generateCode).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: 'corr-1',
        tenantId: 'tenant-1',
        bindLevel: 'CAMPAIGN',
        bindRefId: 'ref-1',
        customerId: 'cust-1',
        merchantId: null,
        transport: 'GRPC',
      }),
    );
  });

  it('maps empty merchant_id to null, never an empty string, on the request passed to the domain service', async () => {
    const generateCode = jest.fn().mockResolvedValue(successResult);
    const controller = buildController(generateCode);

    await controller.generateCode({
      correlationId: 'corr-2',
      tenantId: 'tenant-1',
      bindLevel: 'CAMPAIGN',
      bindRefId: 'ref-1',
      customerId: 'cust-1',
      merchantId: '',
    });

    expect(generateCode).toHaveBeenCalledWith(expect.objectContaining({ merchantId: null }));
  });

  it('maps a FAILED GenerationResult straight through, never throwing a gRPC error status', async () => {
    const failure: GenerationResult = {
      status: 'FAILED',
      promoCodeId: null,
      code: null,
      rewardValueType: null,
      rewardValue: null,
      rewardUnit: null,
      expiresAt: null,
      errorCode: 'CONFIG_NOT_BOUND',
      errorMessage: 'no active binding',
    };
    const generateCode = jest.fn().mockResolvedValue(failure);
    const controller = buildController(generateCode);

    const response = await controller.generateCode({
      correlationId: 'corr-3',
      tenantId: 'tenant-1',
      bindLevel: 'CAMPAIGN',
      bindRefId: 'ref-1',
      customerId: 'cust-1',
      merchantId: '',
    });

    expect(response.status).toBe('FAILED');
    expect(response.errorCode).toBe('CONFIG_NOT_BOUND');
    expect(response.promoCodeId).toBe('');
  });

  it('rejects malformed activity_context.metadata_json as INVALID_REQUEST without calling the domain service', async () => {
    const generateCode = jest.fn().mockResolvedValue(successResult);
    const controller = buildController(generateCode);

    const response = await controller.generateCode({
      correlationId: 'corr-4',
      tenantId: 'tenant-1',
      bindLevel: 'CAMPAIGN',
      bindRefId: 'ref-1',
      customerId: 'cust-1',
      merchantId: '',
      activityContext: { metadataJson: '{not-json' },
    });

    expect(response.status).toBe('FAILED');
    expect(response.errorCode).toBe('INVALID_REQUEST');
    expect(generateCode).not.toHaveBeenCalled();
  });

  it('ListActivePromoCodeConfigs maps repository rows onto the thin summary proto shape', async () => {
    const config: PromoCodeConfig = {
      id: 'config-1',
      tenantId: 'tenant-1',
      merchantId: null,
      name: 'Test config',
      codePrefix: null,
      codePostfix: null,
      codeLength: 8,
      characterSet: 'ALPHANUMERIC',
      excludeAmbiguousChars: false,
      rewardValueType: 'FIXED_AMOUNT',
      rewardValue: '10.0000',
      rewardUnit: 'USD',
      maxRedemptionsPerCode: 1,
      codeExpiryDays: null,
      status: 'ACTIVE',
      createdBy: 'actor-1',
      updatedBy: 'actor-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const list = jest.fn().mockResolvedValue([config]);
    const controller = buildController(jest.fn(), list);

    const response = await controller.listActivePromoCodeConfigs({
      tenantId: 'tenant-1',
      merchantId: '',
    });

    expect(response).toEqual({
      configs: [
        {
          id: 'config-1',
          name: 'Test config',
          rewardValueType: 'FIXED_AMOUNT',
          rewardValue: '10.0000',
          rewardUnit: 'USD',
        },
      ],
    });
    expect(list).toHaveBeenCalledWith('tenant-1', { merchantId: undefined, status: 'ACTIVE' });
  });

  it('ListActivePromoCodeConfigs rejects a missing tenant_id with INVALID_ARGUMENT, not a business FAILED response', async () => {
    const controller = buildController(jest.fn());

    await expect(
      controller.listActivePromoCodeConfigs({ tenantId: '', merchantId: '' }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.INVALID_ARGUMENT }),
    });
  });
});

describe('T-PC-031 — proto file structural checks (TC-10/TC-11)', () => {
  const proto = readFileSync(PROTO_PATH, 'utf8');

  // TC-10: every money-shaped field is `string`, never a numeric proto type.
  it('TC-10: reward_value and activity_context.amount are declared as string', () => {
    expect(proto).toMatch(/string\s+reward_value\s*=/);
    expect(proto).toMatch(/string\s+amount\s*=/);
    // Negative half of the assertion: neither field name is ever paired with a numeric proto
    // type anywhere in the file (double/float/int32/int64/uint32/uint64/sint32/sint64/fixed32/
    // fixed64/sfixed32/sfixed64) — a change-detector would only check the positive case above.
    const numericTypes =
      '(double|float|int32|int64|uint32|uint64|sint32|sint64|fixed32|fixed64|sfixed32|sfixed64)';
    expect(proto).not.toMatch(new RegExp(`${numericTypes}\\s+reward_value\\s*=`));
    expect(proto).not.toMatch(new RegExp(`${numericTypes}\\s+amount\\s*=`));
  });

  // TC-11: exactly the two specified RPCs, no extras.
  it('TC-11: declares exactly GenerateCode and ListActivePromoCodeConfigs, nothing else', () => {
    const rpcLines = proto
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('rpc '));
    expect(rpcLines).toHaveLength(2);
    expect(rpcLines[0]).toMatch(/^rpc GenerateCode /);
    expect(rpcLines[1]).toMatch(/^rpc ListActivePromoCodeConfigs /);
  });
});

describe('T-PC-031 — R10 code-inspection guard (TC-12)', () => {
  const controllerSource = readFileSync(CONTROLLER_SOURCE_PATH, 'utf8');

  // TC-12: no collision-retry/idempotency/binding-resolution logic in the transport adapter.
  // Scans for the actual symbols that logic would require, not just a comment mentioning them
  // (a comment explaining *why there is none* — like this file's own header — must not trip it).
  it('TC-12: the controller never references collision-retry/binding-resolution internals', () => {
    const forbiddenSymbols = [
      'maxRetryAttempts',
      'CodeGenerator',
      'CampaignBindingService',
      'resolveActiveBinding',
      'findByCorrelationId',
      'isCodeCollision',
      'INSERT INTO',
      'sequelize.transaction',
    ];
    for (const symbol of forbiddenSymbols) {
      expect(controllerSource).not.toContain(symbol);
    }
  });

  it('TC-12 (adjacent): the controller only ever calls generateCode() on the injected service, never re-implements it', () => {
    const generateCodeCallSites =
      controllerSource.match(/this\.generationService\.generateCode\(/g) ?? [];
    expect(generateCodeCallSites).toHaveLength(1);
  });
});
