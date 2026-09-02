/**
 * T-PC-056. `PromoCodeGenerateController` — boots the real `AppModule` (proving
 * `GenerationServiceTokenGuard` + this controller + `PromoCodeGenerationService` +
 * `PromoCodeRepository` wiring end to end, not a mocked layer) against the real, migrated
 * `promo_code` schema on the real Postgres 16 server (root `CLAUDE.md`) — same real-DB
 * convention `promo-code-config.controller.spec.ts` (T-PC-011) and
 * `promo-code-generation.service.spec.ts` (T-PC-021) already established, per
 * `AGENT-PROTOCOL.md` §3.
 *
 * TC-1/TC-2 (successful generation, persisted with `transport = 'REST'`, idempotent replay) and
 * TC-7 (cross-transport parity, success case) require `promo_code.promo_code.transport`'s `CHECK`
 * constraint to accept `'REST'` — tracked as its own migration, T-PC-057 (filed against
 * `agent-promo-foundation`, `src/database/**` is outside this agent's own file scope, R8). Until
 * that migration lands, those three cases fail at the DB insert step with a real `CHECK
 * (transport IN (...))` violation — expected, documented in this task's completion report, not
 * silently skipped (AGENT-PROTOCOL.md R9's "do not mark done with a failing check" is why this
 * task is `blocked` on T-PC-057 rather than `review`).
 *
 * Deviation from the task file's literal path (`test/e2e/rest-generate-parity.e2e-spec.ts` for the
 * parity case specifically): `test/e2e/**` is exclusively granted to `agent-promo-qa` in
 * `project.config.json`, not this agent — same class of deviation `promo-code-config.controller
 * .spec.ts`'s own header documents for `test/config/**` vs. its task file's literal
 * `test/modules/promo-code-config/**`. TC-7 (cross-transport parity) is folded into this file
 * instead of a separate `test/modules/generation/rest-generate-parity.e2e-spec.ts`, since it needs
 * the exact same `AppModule`/seed fixtures as every other case here. See this task's completion
 * report, "Deviations from spec".
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { AppModule } from '@/app.module';
import { PromoCodeConfigRepository } from '@/modules/promo-code-config/promo-code-config.repository';
import { PromoCodeConfigAuditRepository } from '@/modules/promo-code-config/promo-code-config-audit.repository';
import { PromoCodeConfigService } from '@/modules/promo-code-config/promo-code-config.service';
import { CampaignBindingRepository } from '@/modules/campaign-binding/campaign-binding.repository';
import { CampaignBindingService } from '@/modules/campaign-binding/campaign-binding.service';
import { PromoCodeController as GrpcPromoCodeController } from '@/grpc/promo-code.controller';
import { PromoCodeGenerationService } from '@/modules/generation/promo-code-generation.service';
import { CodeGenerator } from '@/modules/generation/code-generator';
import { PromoCodeRepository } from '@/modules/generation/promo-code.repository';
import { DEFAULT_GENERATION_MAX_RETRY_ATTEMPTS } from '@/modules/generation/promo-code-generation.constants';
import { CorrelationContextService } from '@/observability/logging/correlation-context.service';
// Read-only reuse of a test support helper another agent's task owns; not an edit (same
// cross-suite import convention `promo-code-generation.service.spec.ts`'s own header documents).
import { createAppTestConnection } from '../../config/support/app-connection';

const GENERATE_PATH = '/api/v1/promo-codes/generate';

const VALID_TOKEN = (): string => process.env.GENERATION_SERVICE_TOKEN as string;
const INTERNAL_TOKEN = (): string => process.env.INTERNAL_SERVICE_TOKEN as string;

function authHeader(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}

describe('T-PC-056 — PromoCodeGenerateController (REST)', () => {
  let app: INestApplication;
  let sequelize: Sequelize;
  let promoCodeConfigRepository: PromoCodeConfigRepository;
  let promoCodeConfigService: PromoCodeConfigService;
  let bindingService: CampaignBindingService;
  // Built directly (not through `AppModule`'s own DI) purely for TC-7's own gRPC-side comparison
  // call — no new server, no new port, just the same in-process controller class the real gRPC
  // server module wires up, called directly the same way `test/grpc/promo-code.controller.spec.ts`
  // already does.
  let grpcController: GrpcPromoCodeController;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    sequelize = createAppTestConnection();
    await sequelize.authenticate();
    promoCodeConfigRepository = new PromoCodeConfigRepository(sequelize);
    const auditRepository = new PromoCodeConfigAuditRepository(sequelize);
    promoCodeConfigService = new PromoCodeConfigService(
      promoCodeConfigRepository,
      auditRepository,
      sequelize,
    );
    const bindingRepository = new CampaignBindingRepository(sequelize);
    bindingService = new CampaignBindingService(
      bindingRepository,
      promoCodeConfigService,
      sequelize,
    );

    const generationService = new PromoCodeGenerationService(
      new PromoCodeRepository(sequelize),
      bindingService,
      promoCodeConfigService,
      new CodeGenerator(),
      sequelize,
      DEFAULT_GENERATION_MAX_RETRY_ATTEMPTS,
    );
    grpcController = new GrpcPromoCodeController(
      generationService,
      promoCodeConfigRepository,
      new CorrelationContextService(),
    );
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      await sequelize.query(
        `DELETE FROM promo_code.promo_code_outbox
           WHERE promo_code_id IN (SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantId)`,
        { replacements: { tenantId } },
      );
      await sequelize.query('DELETE FROM promo_code.promo_code WHERE tenant_id = :tenantId', {
        replacements: { tenantId },
      });
      await sequelize.query(
        'DELETE FROM promo_code.campaign_promo_config WHERE tenant_id = :tenantId',
        { replacements: { tenantId } },
      );
      await sequelize.query(
        `DELETE FROM promo_code.promo_code_config_audit
           WHERE promo_code_config_id IN (
             SELECT id FROM promo_code.promo_code_config WHERE tenant_id = :tenantId
           )`,
        { replacements: { tenantId } },
      );
      await sequelize.query(
        'DELETE FROM promo_code.promo_code_config WHERE tenant_id = :tenantId',
        {
          replacements: { tenantId },
        },
      );
    }
    await sequelize.close();
    await app.close();
  });

  function freshTenant(): string {
    const id = randomUUID();
    tenantIds.push(id);
    return id;
  }

  async function seedActiveConfig(tenantId: string): Promise<string> {
    const config = await promoCodeConfigRepository.create(tenantId, {
      merchantId: null,
      name: `t-pc-056 config ${randomUUID()}`,
      codePrefix: null,
      codePostfix: null,
      codeLength: 12,
      characterSet: 'ALPHANUMERIC',
      excludeAmbiguousChars: true,
      rewardValueType: 'FIXED_AMOUNT',
      rewardValue: 10,
      rewardUnit: 'USD',
      maxRedemptionsPerCode: 1,
      codeExpiryDays: null,
      createdBy: randomUUID(),
    });
    return config.id;
  }

  async function bindConfig(tenantId: string, promoCodeConfigId: string): Promise<string> {
    const bindRefId = randomUUID();
    await bindingService.bind({
      promoCodeConfigId,
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      boundBy: randomUUID(),
    });
    return bindRefId;
  }

  function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      correlationId: randomUUID(),
      tenantId: randomUUID(),
      bindLevel: 'CAMPAIGN',
      bindRefId: randomUUID(),
      customerId: 'cust_8213',
      ...overrides,
    };
  }

  // TC-1
  it('TC-1: valid request + valid GENERATION_SERVICE_TOKEN returns 200 SUCCESS with a real, persisted transport=REST row', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    const bindRefId = await bindConfig(tenantId, configId);

    const response = await request(app.getHttpServer())
      .post(GENERATE_PATH)
      .set(...authHeader(VALID_TOKEN()))
      .send(validBody({ tenantId, bindRefId }));

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('SUCCESS');
    expect(response.body.code).toBeTruthy();

    const rows = await sequelize.query<{ transport: string }>(
      'SELECT transport FROM promo_code.promo_code WHERE id = :id',
      { replacements: { id: response.body.promoCodeId }, type: QueryTypes.SELECT },
    );
    expect(rows[0]?.transport).toBe('REST');
  });

  // TC-2
  it('TC-2: the same correlationId submitted twice returns the identical cached result, no second row', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    const bindRefId = await bindConfig(tenantId, configId);
    const body = validBody({ tenantId, bindRefId });

    const first = await request(app.getHttpServer())
      .post(GENERATE_PATH)
      .set(...authHeader(VALID_TOKEN()))
      .send(body);
    const second = await request(app.getHttpServer())
      .post(GENERATE_PATH)
      .set(...authHeader(VALID_TOKEN()))
      .send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.promoCodeId).toBe(first.body.promoCodeId);
    expect(second.body.code).toBe(first.body.code);
  });

  // TC-3
  it('TC-3: missing Authorization header returns 401', async () => {
    const response = await request(app.getHttpServer()).post(GENERATE_PATH).send(validBody());
    expect(response.status).toBe(401);
  });

  it('TC-3: wrong/garbage Authorization header returns 401', async () => {
    const response = await request(app.getHttpServer())
      .post(GENERATE_PATH)
      .set(...authHeader('garbage-token-value'))
      .send(validBody());
    expect(response.status).toBe(401);
  });

  // TC-4
  it("TC-4: presenting INTERNAL_SERVICE_TOKEN's own value returns 401 — the two secrets are not interchangeable", async () => {
    const response = await request(app.getHttpServer())
      .post(GENERATE_PATH)
      .set(...authHeader(INTERNAL_TOKEN()))
      .send(validBody());
    expect(response.status).toBe(401);
  });

  // TC-5
  it('TC-5: a bindLevel/bindRefId that does not resolve to an ACTIVE binding returns 200 FAILED CONFIG_NOT_BOUND', async () => {
    const tenantId = freshTenant();

    const response = await request(app.getHttpServer())
      .post(GENERATE_PATH)
      .set(...authHeader(VALID_TOKEN()))
      .send(validBody({ tenantId }));

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('FAILED');
    expect(response.body.errorCode).toBe('CONFIG_NOT_BOUND');
  });

  // TC-6
  it('TC-6: a malformed body (missing customerId) returns 400, never reaching the generation service', async () => {
    const body = validBody();
    delete (body as Record<string, unknown>).customerId;

    const response = await request(app.getHttpServer())
      .post(GENERATE_PATH)
      .set(...authHeader(VALID_TOKEN()))
      .send(body);

    expect(response.status).toBe(400);
  });

  it('TC-6: a malformed body (missing customerId) with no auth header still returns 401 first', async () => {
    const body = validBody();
    delete (body as Record<string, unknown>).customerId;

    // Documents implementation note/TC-6's own "your call which runs first": this controller
    // relies on Nest's default pipeline order (guards before the handler body ever runs), so an
    // unauthenticated request is rejected 401 even when the body is also malformed.
    const response = await request(app.getHttpServer()).post(GENERATE_PATH).send(body);
    expect(response.status).toBe(401);
  });

  // TC-7
  it('TC-7: cross-transport parity — identical input produces the same CONFIG_NOT_BOUND outcome over REST and gRPC', async () => {
    const tenantId = freshTenant();
    const correlationId = randomUUID();
    const bindRefId = randomUUID();

    const restResponse = await request(app.getHttpServer())
      .post(GENERATE_PATH)
      .set(...authHeader(VALID_TOKEN()))
      .send(
        validBody({
          tenantId,
          bindRefId,
          correlationId,
          customerId: 'cust_parity',
        }),
      );

    const grpcResponse = await grpcController.generateCode({
      correlationId: randomUUID(),
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust_parity',
      merchantId: '',
      activityContext: undefined,
    });

    expect(restResponse.status).toBe(200);
    expect(restResponse.body.status).toBe('FAILED');
    expect(restResponse.body.errorCode).toBe('CONFIG_NOT_BOUND');
    expect(grpcResponse.status).toBe('FAILED');
    expect(grpcResponse.errorCode).toBe('CONFIG_NOT_BOUND');
  });

  // TC-7 (success case) — requires T-PC-057 (transport CHECK constraint widen); see this file's
  // own header and this task's completion report.
  it('TC-7: cross-transport parity — identical input produces the same SUCCESS shape (modulo envelope) over REST and gRPC', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    const bindRefId = await bindConfig(tenantId, configId);

    const restResponse = await request(app.getHttpServer())
      .post(GENERATE_PATH)
      .set(...authHeader(VALID_TOKEN()))
      .send(validBody({ tenantId, bindRefId, customerId: 'cust_parity_success' }));

    const grpcResponse = await grpcController.generateCode({
      correlationId: randomUUID(),
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust_parity_success',
      merchantId: '',
      activityContext: undefined,
    });

    expect(restResponse.body.status).toBe('SUCCESS');
    expect(grpcResponse.status).toBe('SUCCESS');
    expect(restResponse.body.rewardValueType).toBe(grpcResponse.rewardValueType);
    expect(restResponse.body.rewardValue).toBe(grpcResponse.rewardValue);
    expect(restResponse.body.rewardUnit).toBe(grpcResponse.rewardUnit);
  });
});
