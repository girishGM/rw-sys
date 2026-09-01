/**
 * T-PC-041. Cross-tenant isolation (R2/R3), the identical probe repeated against all three
 * transports — this task's own implementation note 3: "a scoping bug that's specific to one
 * transport's field-mapping code... would only be caught by testing each transport's actual
 * request path, not by trusting that testing REST once covers the principle everywhere."
 *
 * The scenario is the same shape on every transport: tenant A has a real, `ACTIVE`
 * `promo_code_config` bound at a real `bindRefId`; tenant B (a different, otherwise-fully-
 * authenticated caller — a valid internal-service token for REST, a valid allowlisted mTLS
 * identity for gRPC, a structurally valid envelope for Kafka) attempts to read or act on that
 * exact same `bindRefId`/config id under its own `tenantId`, and must never see, resolve, or act
 * on tenant A's row. `PromoCodeConfigRepository`/`CampaignBindingRepository`/`PromoCodeRepository`
 * (read directly, T-PC-010/012/021) already bake `tenant_id` into every `WHERE` clause — this
 * suite proves that discipline holds end-to-end through each transport's own request-mapping
 * code, not just at the repository layer in isolation.
 *
 * Reuses `E2ETestHarness` (`test/e2e/setup/e2e-test-app.ts`, T-PC-040's own owned file — imported
 * read-only, never edited, per R8) for the same three-transport composition root every other
 * `test/e2e/**` spec already boots.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import { GENERATE_REQUESTED_TOPIC } from '@/messaging/kafka-consumer.config';
import { GENERATE_RESULT_TOPIC } from '@/modules/generation/promo-code-generation.constants';
import { callGenerateCode, callListActivePromoCodeConfigs } from '../grpc/support/test-grpc-client';
import { E2ETestHarness, waitForKafkaMessage, withOutboxPump } from '../e2e/setup/e2e-test-app';

jest.setTimeout(90_000);

describe('T-PC-041 — cross-tenant isolation, identical probe across REST/gRPC/Kafka (e2e)', () => {
  let harness: E2ETestHarness;

  beforeAll(async () => {
    harness = await E2ETestHarness.create();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  function authHeader(): [string, string] {
    return ['Authorization', `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`];
  }

  // --- REST -----------------------------------------------------------------------------------

  it('REST: GET list scoped to tenant B never returns tenant A’s config', async () => {
    const { tenantId: tenantA, configId } = await harness.createBoundConfig({
      codePrefix: 'XTR1-',
    });
    const tenantB = harness.freshTenant();

    const response = await request(harness.app.getHttpServer())
      .get('/api/v1/promo-code-configs')
      .query({ tenantId: tenantB })
      .set(...authHeader());

    expect(response.status).toBe(200);
    const ids = (response.body.configs as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(configId);
    expect(tenantA).not.toBe(tenantB);
  });

  it('REST: PATCH under tenant B against tenant A’s configId returns 404, never mutates it', async () => {
    const { tenantId: tenantA, configId } = await harness.createBoundConfig({
      codePrefix: 'XTR2-',
    });
    const tenantB = harness.freshTenant();
    const actorB = randomUUID();

    const response = await request(harness.app.getHttpServer())
      .patch(`/api/v1/promo-code-configs/${configId}`)
      .set(...authHeader())
      .send({ tenantId: tenantB, actorId: actorB, rewardValue: 999 });

    expect(response.status).toBe(404);

    // Tenant A's own row is untouched — still readable by tenant A, with the original value.
    const stillOwnedByA = await request(harness.app.getHttpServer())
      .get('/api/v1/promo-code-configs')
      .query({ tenantId: tenantA })
      .set(...authHeader());
    const configA = (stillOwnedByA.body.configs as Array<{ id: string; rewardValue: string }>).find(
      (c) => c.id === configId,
    );
    expect(configA).toBeDefined();
    expect(configA?.rewardValue).not.toBe('999.0000');
  });

  it('REST: POST bind under tenant B against tenant A’s promoCodeConfigId returns 409, never binds it', async () => {
    const { tenantId: tenantA, configId } = await harness.createBoundConfig({
      codePrefix: 'XTR3-',
    });
    const tenantB = harness.freshTenant();
    const bindRefIdB = randomUUID();

    const response = await request(harness.app.getHttpServer())
      .post('/api/v1/campaign-promo-configs')
      .set(...authHeader())
      .send({
        promoCodeConfigId: configId,
        tenantId: tenantB,
        bindLevel: 'CAMPAIGN',
        bindRefId: bindRefIdB,
        boundBy: randomUUID(),
      });

    expect(response.status).toBe(409);
    expect(tenantA).not.toBe(tenantB);
  });

  it('REST: DELETE (archive) under tenant B against tenant A’s configId returns 404, never archives it', async () => {
    const { tenantId: tenantA, configId } = await harness.createBoundConfig({
      codePrefix: 'XTR4-',
    });
    const tenantB = harness.freshTenant();

    const response = await request(harness.app.getHttpServer())
      .delete(`/api/v1/promo-code-configs/${configId}`)
      .query({ tenantId: tenantB, actorId: randomUUID() })
      .set(...authHeader());

    expect(response.status).toBe(404);

    // Tenant A's own row is still ACTIVE — never archived by tenant B's attempt.
    const stillActive = await request(harness.app.getHttpServer())
      .get('/api/v1/promo-code-configs')
      .query({ tenantId: tenantA })
      .set(...authHeader());
    const ids = (stillActive.body.configs as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(configId);
    expect(tenantA).not.toBe(tenantB);
  });

  // --- gRPC -------------------------------------------------------------------------------------

  it('gRPC: GenerateCode under tenant B against tenant A’s bindRefId never resolves tenant A’s binding', async () => {
    const { tenantId: tenantA, bindRefId } = await harness.createBoundConfig({
      codePrefix: 'XTG1-',
    });
    const tenantB = harness.freshTenant();
    const client = harness.allowedGrpcClient();

    const response = await callGenerateCode(client, {
      correlationId: randomUUID(),
      tenantId: tenantB,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-xt-grpc',
      merchantId: '',
    });

    expect(response.status).toBe('FAILED');
    expect(response.errorCode).toBe('CONFIG_NOT_BOUND');
    expect(tenantA).not.toBe(tenantB);
    client.close();
  });

  it('gRPC: ListActivePromoCodeConfigs under tenant B never returns tenant A’s config', async () => {
    const { configId } = await harness.createBoundConfig({ codePrefix: 'XTG2-' });
    const tenantB = harness.freshTenant();
    const client = harness.allowedGrpcClient();

    const response = await callListActivePromoCodeConfigs(client, {
      tenantId: tenantB,
      merchantId: '',
    });

    const ids = (response.configs ?? []).map((c) => c.id);
    expect(ids).not.toContain(configId);
    client.close();
  });

  // --- Kafka ------------------------------------------------------------------------------------

  it('Kafka: generate.requested under tenant B against tenant A’s bindRefId never resolves tenant A’s binding', async () => {
    const { tenantId: tenantA, bindRefId } = await harness.createBoundConfig({
      codePrefix: 'XTK1-',
    });
    const tenantB = harness.freshTenant();
    const correlationId = randomUUID();

    await harness.publishGenerateRequested(GENERATE_REQUESTED_TOPIC, correlationId, tenantB, {
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-xt-kafka',
      merchantId: null,
    });

    // No outbox row is ever created for a FAILED result (implementation note 5,
    // `promo-code-generation.service.ts`: the outbox row is only written on a successful
    // transactional insert), so this is observed directly against the database rather than by
    // waiting on a result message that will never be published.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const rows = await harness.sequelize.query<{ id: string }>(
      `SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantB AND correlation_id = :correlationId`,
      { type: QueryTypes.SELECT, replacements: { tenantB, correlationId } },
    );
    expect(rows).toHaveLength(0);
    expect(tenantA).not.toBe(tenantB);
  });

  it('Kafka: a successful generate.requested under the correct tenant is unaffected by another tenant sharing the same bindRefId value (control)', async () => {
    // Sanity control for the negative probes above: prove the *positive* path still works when
    // tenantId and bindRefId genuinely match, so a passing negative test here isn't accidentally
    // explained by the whole pipeline being broken.
    const { tenantId, bindRefId } = await harness.createBoundConfig({ codePrefix: 'XTK2-' });
    const correlationId = randomUUID();

    const resultMessage = await withOutboxPump(harness, tenantId, correlationId, async () => {
      await harness.publishGenerateRequested(GENERATE_REQUESTED_TOPIC, correlationId, tenantId, {
        bindLevel: 'CAMPAIGN',
        bindRefId,
        customerId: 'cust-xt-kafka-control',
        merchantId: null,
      });
      return waitForKafkaMessage(GENERATE_RESULT_TOPIC, 60_000, (key) => key === correlationId);
    });
    const data = resultMessage.data as Record<string, unknown>;
    expect(data.status).toBe('SUCCESS');
  });
});
