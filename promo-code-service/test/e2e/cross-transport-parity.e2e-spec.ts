/**
 * T-PC-040. The test that directly protects gate `G3` in `progress.json`: "Kafka and gRPC paths
 * produce identical results for identical requests" (`ARCHITECTURE.md` §6's core architectural
 * promise — both transports call the exact same `PromoCodeGenerationService.generateCode()`, so a
 * seam between them is a design violation, not a legitimate difference). Written deliberately, not
 * bolted onto `kafka-round-trip.e2e-spec.ts`/`grpc-round-trip.e2e-spec.ts` as an afterthought
 * (implementation note 3).
 *
 * TC-3 generates via gRPC for one binding and via Kafka for a structurally identical request
 * against a second binding built from the *same* config recipe, then asserts both results carry
 * the same fields with the same semantics — allowing for the two expected, documented differences
 * only: the Kafka path's asynchronous delivery (a published `generate.result.v1` message) vs. the
 * gRPC path's synchronous response, and each transport's own request/response envelope shape
 * (`data` vs. a flat proto message) — never a difference in the *business* fields themselves
 * (`rewardValueType`/`rewardValue`/`rewardUnit`/code shape/`status`).
 *
 * TC-9 is a second, related parity case: `ListActivePromoCodeConfigs` over gRPC must return
 * exactly the same config set/summary fields `GET /api/v1/promo-code-configs` (T-PC-011) would for
 * the same tenant — both are thin reads over the identical `PromoCodeConfigRepository.list()` call
 * (`grpc/promo-code.controller.ts`'s own header), so any drift here is exactly the kind of
 * transport-specific seam this task exists to catch.
 *
 * **Deviation from the task file's literal Verification step 1 command (`npm run test:e2e`)**: no
 * `test:e2e` script exists in `package.json` — same precedent as every sibling spec in this suite
 * (see `kafka-round-trip.e2e-spec.ts`'s own header).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { GENERATE_REQUESTED_TOPIC } from '@/messaging/kafka-consumer.config';
import { GENERATE_RESULT_TOPIC } from '@/modules/generation/promo-code-generation.constants';
import { callGenerateCode, callListActivePromoCodeConfigs } from '../grpc/support/test-grpc-client';
import { E2ETestHarness, waitForKafkaMessage, withOutboxPump } from './setup/e2e-test-app';

jest.setTimeout(60_000);

describe('T-PC-040 — cross-transport parity (gate G3) (e2e)', () => {
  let harness: E2ETestHarness;

  beforeAll(async () => {
    harness = await E2ETestHarness.create();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  // TC-3
  it('TC-3: gRPC GenerateCode and a Kafka generate.requested round trip against the same config recipe produce equivalent results', async () => {
    const recipe = {
      codePrefix: 'PARITY-',
      rewardValueType: 'PERCENTAGE' as const,
      rewardValue: 12,
      rewardUnit: '%',
      codeExpiryDays: 45,
    };
    const grpcFixture = await harness.createBoundConfig(recipe);
    const kafkaFixture = await harness.createBoundConfig(recipe);

    const client = harness.allowedGrpcClient();
    const grpcResponse = await callGenerateCode(client, {
      correlationId: randomUUID(),
      tenantId: grpcFixture.tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId: grpcFixture.bindRefId,
      customerId: 'cust-parity-grpc',
      merchantId: '',
    });
    client.close();

    const kafkaCorrelationId = randomUUID();
    const kafkaResultMessage = await withOutboxPump(
      harness,
      kafkaFixture.tenantId,
      kafkaCorrelationId,
      async () => {
        await harness.publishGenerateRequested(
          GENERATE_REQUESTED_TOPIC,
          kafkaCorrelationId,
          kafkaFixture.tenantId,
          {
            bindLevel: 'CAMPAIGN',
            bindRefId: kafkaFixture.bindRefId,
            customerId: 'cust-parity-kafka',
            merchantId: null,
            activityContext: null,
          },
        );
        return waitForKafkaMessage(
          GENERATE_RESULT_TOPIC,
          60_000,
          (key) => key === kafkaCorrelationId,
        );
      },
    );
    const kafkaData = kafkaResultMessage.data as Record<string, unknown>;

    // Both requests were structurally identical (same recipe, different tenant/binding) — the
    // business-field values below must be identical in semantics, allowing only for each
    // transport's own envelope shape and delivery mechanism (implementation note 3).
    expect(grpcResponse.status).toBe('SUCCESS');
    expect(kafkaData.status).toBe('SUCCESS');
    expect(grpcResponse.rewardValueType).toBe(kafkaData.rewardValueType);
    expect(grpcResponse.rewardValue).toBe(kafkaData.rewardValue);
    expect(grpcResponse.rewardUnit).toBe(kafkaData.rewardUnit);
    expect(grpcResponse.code.startsWith('PARITY-')).toBe(true);
    expect((kafkaData.code as string).startsWith('PARITY-')).toBe(true);
    expect(typeof grpcResponse.expiresAt).toBe('string');
    expect(grpcResponse.expiresAt.length).toBeGreaterThan(0);
    expect(typeof kafkaData.expiresAt).toBe('string');
    expect(grpcResponse.errorCode).toBe('');
    expect(kafkaData.errorCode).toBeNull();
  });

  // TC-9
  it('TC-9: ListActivePromoCodeConfigs (gRPC) returns the same config set/fields as GET /api/v1/promo-code-configs (REST)', async () => {
    const tenantId = harness.freshTenant();
    const actorId = randomUUID();
    const authHeader: [string, string] = [
      'Authorization',
      `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
    ];

    const createResponse = await request(harness.app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...authHeader)
      .send({
        tenantId,
        actorId,
        name: `t-pc-040 tc9 ${randomUUID()}`,
        codeLength: 8,
        characterSet: 'NUMERIC',
        rewardValueType: 'POINTS',
        rewardValue: 250,
        rewardUnit: 'pts',
      });
    expect(createResponse.status).toBe(201);

    const restResponse = await request(harness.app.getHttpServer())
      .get('/api/v1/promo-code-configs')
      .query({ tenantId })
      .set(...authHeader);
    expect(restResponse.status).toBe(200);

    const client = harness.allowedGrpcClient();
    const grpcResponse = await callListActivePromoCodeConfigs(client, { tenantId, merchantId: '' });
    client.close();

    const restConfigs = (
      restResponse.body.configs as Array<{
        id: string;
        name: string;
        rewardValueType: string;
        rewardValue: string;
        rewardUnit: string;
      }>
    )
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    const grpcConfigs = grpcResponse.configs.slice().sort((a, b) => a.id.localeCompare(b.id));

    expect(grpcConfigs).toEqual(restConfigs);
  });
});
