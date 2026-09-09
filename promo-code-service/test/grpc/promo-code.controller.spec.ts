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
import type {
  PromoCodeConfigListItem,
  PromoCodeConfigRepository,
} from '@/modules/promo-code-config/promo-code-config.repository';
import type { GenerationResult } from '@/modules/generation/generation-result.types';
import { CorrelationContextService } from '@/observability/logging/correlation-context.service';

const PROTO_PATH = join(__dirname, '..', '..', 'proto', 'promo_code.v1.proto');
const CONTROLLER_SOURCE_PATH = join(
  __dirname,
  '..',
  '..',
  'src',
  'grpc',
  'promo-code.controller.ts',
);
const GRPC_SERVER_MODULE_SOURCE_PATH = join(
  __dirname,
  '..',
  '..',
  'src',
  'grpc',
  'grpc-server.module.ts',
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
    // T-PC-062: renamed from `list` — `PromoCodeController.listActivePromoCodeConfigs` now calls
    // `PromoCodeConfigRepository.listSummaries()` (T-PC-058 moved every payout column off
    // `promo_code_config` onto `promo_code_config_version`; `listSummaries()` joins to the
    // currently-`published` version, mirroring `GET /api/v1/promo-code-configs`'s own fix).
    listSummaries: jest.Mock = jest.fn().mockResolvedValue([]),
    correlationContext: CorrelationContextService = new CorrelationContextService(),
  ): PromoCodeController {
    const generationService = { generateCode } as unknown as PromoCodeGenerationService;
    const repository = { listSummaries } as unknown as PromoCodeConfigRepository;
    return new PromoCodeController(generationService, repository, correlationContext);
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
      // T-PC-062: this fixture's own `successResult` never sets `versionNo` — `''` is the
      // `nullToEmpty(undefined)` fallback, not a hardcoded placeholder (see the dedicated
      // "echoes a populated versionNo" case below for the populated path).
      versionNo: '',
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

  // T-PC-062 (regression): once `GenerationResult.versionNo` is actually populated (T-PC-060's
  // own scope, now landed), the response echoes it — this line was `versionNo: ''` unconditionally
  // before this task's fix, which would fail this exact assertion.
  it('echoes a populated GenerationResult.versionNo back onto the response, not a hardcoded empty string', async () => {
    const generateCode = jest.fn().mockResolvedValue({ ...successResult, versionNo: '3' });
    const controller = buildController(generateCode);

    const response = await controller.generateCode({
      correlationId: 'corr-7',
      tenantId: 'tenant-1',
      bindLevel: 'CAMPAIGN',
      bindRefId: 'ref-1',
      customerId: 'cust-1',
      merchantId: '',
    });

    expect(response.versionNo).toBe('3');
  });

  // T-PC-061 TC-2/TC-4: an explicit version_no on the request is passed through to the domain
  // service untouched (a caller that already resolved a pin upstream is never silently dropped at
  // this adapter) — proves the request-side half of the wire contract without depending on
  // T-PC-060's own resolution logic being present yet.
  it('T-PC-061: passes an explicit version_no on the request through to generateCode() untouched', async () => {
    const generateCode = jest.fn().mockResolvedValue(successResult);
    const controller = buildController(generateCode);

    await controller.generateCode({
      correlationId: 'corr-5',
      tenantId: 'tenant-1',
      bindLevel: 'CAMPAIGN',
      bindRefId: 'ref-1',
      customerId: 'cust-1',
      merchantId: '',
      versionNo: '3',
    });

    expect(generateCode).toHaveBeenCalledWith(expect.objectContaining({ versionNo: '3' }));
  });

  // T-PC-061 (adjacent behaviour unchanged): an absent version_no maps to `null`, exactly the
  // existing convention for every other optional string field on this request (`merchant_id`).
  it('T-PC-061: an absent version_no maps to null, not an empty string, on the request passed to the domain service', async () => {
    const generateCode = jest.fn().mockResolvedValue(successResult);
    const controller = buildController(generateCode);

    await controller.generateCode({
      correlationId: 'corr-6',
      tenantId: 'tenant-1',
      bindLevel: 'CAMPAIGN',
      bindRefId: 'ref-1',
      customerId: 'cust-1',
      merchantId: '',
    });

    expect(generateCode).toHaveBeenCalledWith(expect.objectContaining({ versionNo: null }));
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

  // T-PC-062 (regression — reproduces the defect T-PC-058 reported): before this fix,
  // `listActivePromoCodeConfigs` called `PromoCodeConfigRepository.list()`, which no longer exists
  // on this mocked repository shape (only `listSummaries` is stubbed here) — reverting the
  // controller to call `.list(...)` again makes this test fail with
  // `TypeError: ...repository.list is not a function`, proving this test actually pins the fix.
  it('ListActivePromoCodeConfigs maps listSummaries() rows onto the thin summary proto shape', async () => {
    const config: PromoCodeConfigListItem = {
      id: 'config-1',
      name: 'Test config',
      rewardValueType: 'FIXED_AMOUNT',
      rewardValue: '10.0000',
      rewardUnit: 'USD',
    };
    const listSummaries = jest.fn().mockResolvedValue([config]);
    const controller = buildController(jest.fn(), listSummaries);

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
    expect(listSummaries).toHaveBeenCalledWith('tenant-1', {
      merchantId: undefined,
      status: 'ACTIVE',
    });
  });

  it('ListActivePromoCodeConfigs rejects a missing tenant_id with INVALID_ARGUMENT, not a business FAILED response', async () => {
    const controller = buildController(jest.fn());

    await expect(
      controller.listActivePromoCodeConfigs({ tenantId: '', merchantId: '' }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: GrpcStatus.INVALID_ARGUMENT }),
    });
  });

  // T-PC-047 (this task's own numbering) — TC-2: the domain service call, which happens deep
  // inside `generateCode()`'s own async body, still sees the correlation context
  // `CorrelationContextService.run(...)` set at the RPC entry point — proving the wrap actually
  // reaches the call, not just the synchronous part of the method before the first `await`.
  it('TC-2: correlation_id/tenant_id/transport/rpc are visible to code called from generateCode()', async () => {
    const correlationContext = new CorrelationContextService();
    let observedDuringCall: unknown;
    const generateCode = jest.fn().mockImplementation(async () => {
      observedDuringCall = correlationContext.getCurrent();
      return successResult;
    });
    const controller = buildController(generateCode, undefined, correlationContext);

    await controller.generateCode({
      correlationId: 'corr-t-pc-047',
      tenantId: 'tenant-t-pc-047',
      bindLevel: 'CAMPAIGN',
      bindRefId: 'ref-1',
      customerId: 'cust-1',
      merchantId: '',
    });

    expect(observedDuringCall).toEqual({
      correlationId: 'corr-t-pc-047',
      tenantId: 'tenant-t-pc-047',
      transport: 'GRPC',
      rpc: 'GenerateCode',
    });
    // No leakage after the RPC returns — `getCurrent()` is only ever populated for the duration of
    // the AsyncLocalStorage `run()` call this RPC's entry point owns.
    expect(correlationContext.getCurrent()).toBeUndefined();
  });

  // TC-3: two concurrent calls never see each other's context (AsyncLocalStorage isolation, not
  // just "the last call's value happened to still be correct").
  it('TC-3: two concurrent GenerateCode calls never observe each other correlation context', async () => {
    const correlationContext = new CorrelationContextService();
    const observed: Record<string, unknown> = {};
    const generateCode = jest.fn().mockImplementation(async () => {
      const current = correlationContext.getCurrent();
      // Yield once so the two calls' async bodies genuinely interleave.
      await new Promise((resolve) => setImmediate(resolve));
      observed[current?.correlationId as string] = correlationContext.getCurrent()?.correlationId;
      return successResult;
    });
    const controller = buildController(generateCode, undefined, correlationContext);

    await Promise.all([
      controller.generateCode({
        correlationId: 'corr-a',
        tenantId: 'tenant-1',
        bindLevel: 'CAMPAIGN',
        bindRefId: 'ref-1',
        customerId: 'cust-a',
        merchantId: '',
      }),
      controller.generateCode({
        correlationId: 'corr-b',
        tenantId: 'tenant-1',
        bindLevel: 'CAMPAIGN',
        bindRefId: 'ref-1',
        customerId: 'cust-b',
        merchantId: '',
      }),
    ]);

    expect(observed).toEqual({ 'corr-a': 'corr-a', 'corr-b': 'corr-b' });
  });

  // TC-1 (T-PC-047's own numbering): a fast, no-broker/no-Postgres-required regression guard for
  // the defect's root cause — `GrpcServerModule` (this task's own fix target) must import
  // `LoggingModule`, or `Logger.overrideLogger`/`CorrelationContextService` never reach this
  // process's DI graph at all, no matter what the controller itself does. Proven to fail on the
  // pre-fix source (reverting `grpc-server.module.ts`'s `imports` array back to
  // `[PromoCodeGenerationModule, PromoCodeConfigModule]` makes this assertion false) — see this
  // task's completion report.
  it('TC-1: GrpcServerModule imports LoggingModule (the T-PC-047 fix target)', () => {
    const moduleSource = readFileSync(GRPC_SERVER_MODULE_SOURCE_PATH, 'utf8');
    expect(moduleSource).toMatch(/LoggingModule/);
    expect(moduleSource).toMatch(/imports:\s*\[[^\]]*LoggingModule[^\]]*\]/);
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
