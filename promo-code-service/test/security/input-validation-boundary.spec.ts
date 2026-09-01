/**
 * T-PC-041. Systematic input-boundary audit — oversized strings and SQL-injection-shaped strings
 * on the free-text fields this service actually accepts, across every transport that accepts
 * them, per this task's own implementation note 2.
 *
 * `PromoCodeConfigRepository`/`CampaignBindingRepository`/`PromoCodeRepository` (T-PC-010/012/021,
 * read directly for this audit) all use `sequelize.query(...)` with named `replacements`, never
 * string concatenation — R2's "scoped repository pattern" plus parameterized queries. This suite
 * confirms that holds under adversarial input rather than assuming it from the convention alone
 * (`AGENT-PROTOCOL.md` §3).
 *
 * Reuses `E2ETestHarness` (`test/e2e/setup/e2e-test-app.ts`, T-PC-040's own owned file — imported
 * read-only, never edited, per R8).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import { callGenerateCode } from '../grpc/support/test-grpc-client';
import { E2ETestHarness, withOutboxPump, waitForKafkaMessage } from '../e2e/setup/e2e-test-app';
import { GENERATE_REQUESTED_TOPIC } from '@/messaging/kafka-consumer.config';
import { GENERATE_RESULT_TOPIC } from '@/modules/generation/promo-code-generation.constants';

jest.setTimeout(90_000);

const SQL_INJECTION_SHAPE = "'; DROP TABLE promo_code.promo_code; --";

describe('T-PC-041 — input-validation boundary audit (real Postgres/broker) (e2e)', () => {
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

  async function tableStillIntact(table: string): Promise<void> {
    // A trivial `SELECT` against the target table this injection payload names — if the DDL
    // implied by the payload's own text had ever actually executed, this query itself would
    // throw ("relation does not exist"). Reaching the assertion below at all is the proof.
    const rows = await harness.sequelize.query(`SELECT 1 FROM ${table} LIMIT 1`, {
      type: QueryTypes.SELECT,
    });
    expect(Array.isArray(rows)).toBe(true);
  }

  // TC-9 (REST `name` field)
  it('TC-9: a SQL-injection-shaped name is stored as an inert literal, never executed — table intact', async () => {
    const tenantId = harness.freshTenant();
    const actorId = randomUUID();

    const response = await request(harness.app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...authHeader())
      .send({
        tenantId,
        actorId,
        name: SQL_INJECTION_SHAPE,
        codeLength: 8,
        characterSet: 'ALPHANUMERIC',
        rewardValueType: 'FIXED_AMOUNT',
        rewardValue: 5,
        rewardUnit: 'USD',
      });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe(SQL_INJECTION_SHAPE);
    await tableStillIntact('promo_code.promo_code_config');

    // Round-trips byte-for-byte through a real read too — never partially executed/truncated.
    const listResponse = await request(harness.app.getHttpServer())
      .get('/api/v1/promo-code-configs')
      .query({ tenantId })
      .set(...authHeader());
    const stored = (listResponse.body.configs as Array<{ name: string }>).find(
      (c) => c.name === SQL_INJECTION_SHAPE,
    );
    expect(stored).toBeDefined();
  });

  // TC-9 (gRPC `customer_id` field)
  it('TC-9: a SQL-injection-shaped customerId over gRPC is stored/compared as an inert literal — table intact', async () => {
    const { tenantId, bindRefId } = await harness.createBoundConfig({ codePrefix: 'INJ-GRPC-' });
    const client = harness.allowedGrpcClient();

    const response = await callGenerateCode(client, {
      correlationId: randomUUID(),
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: SQL_INJECTION_SHAPE,
      merchantId: '',
    });

    expect(response.status).toBe('SUCCESS');
    await tableStillIntact('promo_code.promo_code');

    const rows = await harness.sequelize.query<{ customer_id: string }>(
      `SELECT customer_id FROM promo_code.promo_code WHERE id = :id`,
      { type: QueryTypes.SELECT, replacements: { id: response.promoCodeId } },
    );
    expect(rows[0].customer_id).toBe(SQL_INJECTION_SHAPE);
    client.close();
  });

  // TC-9 (Kafka `customer_id` field)
  it('TC-9: a SQL-injection-shaped customerId over Kafka is stored/compared as an inert literal — table intact', async () => {
    const { tenantId, bindRefId } = await harness.createBoundConfig({ codePrefix: 'INJ-KAFKA-' });
    const correlationId = randomUUID();

    const resultMessage = await withOutboxPump(harness, tenantId, correlationId, async () => {
      await harness.publishGenerateRequested(GENERATE_REQUESTED_TOPIC, correlationId, tenantId, {
        bindLevel: 'CAMPAIGN',
        bindRefId,
        customerId: SQL_INJECTION_SHAPE,
        merchantId: null,
      });
      return waitForKafkaMessage(GENERATE_RESULT_TOPIC, 60_000, (key) => key === correlationId);
    });

    const data = resultMessage.data as Record<string, unknown>;
    expect(data.status).toBe('SUCCESS');
    await tableStillIntact('promo_code.promo_code');

    const rows = await harness.sequelize.query<{ customer_id: string }>(
      `SELECT customer_id FROM promo_code.promo_code WHERE tenant_id = :tenantId AND correlation_id = :correlationId`,
      { type: QueryTypes.SELECT, replacements: { tenantId, correlationId } },
    );
    expect(rows[0].customer_id).toBe(SQL_INJECTION_SHAPE);
  });

  // TC-10
  it('TC-10: an oversized name (> varchar(120)) on POST /api/v1/promo-code-configs is rejected 400 at the DTO layer, never reaches the DB', async () => {
    const tenantId = harness.freshTenant();
    const actorId = randomUUID();
    const oversizedName = 'a'.repeat(121);

    const response = await request(harness.app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...authHeader())
      .send({
        tenantId,
        actorId,
        name: oversizedName,
        codeLength: 8,
        characterSet: 'ALPHANUMERIC',
        rewardValueType: 'FIXED_AMOUNT',
        rewardValue: 5,
        rewardUnit: 'USD',
      });

    expect(response.status).toBe(400);
    expect((response.body.errors as Array<{ path: string }>).some((e) => e.path === 'name')).toBe(
      true,
    );

    const rows = await harness.sequelize.query(
      `SELECT id FROM promo_code.promo_code_config WHERE tenant_id = :tenantId`,
      { type: QueryTypes.SELECT, replacements: { tenantId } },
    );
    expect(rows).toHaveLength(0);
  });

  // TC-10 (adjacent, exactly-at-the-boundary control): a 120-character name is accepted, proving
  // the 400 above is genuinely a length check and not an off-by-one that also rejects valid input.
  it('TC-10 (adjacent): a name of exactly 120 characters is accepted', async () => {
    const tenantId = harness.freshTenant();
    const actorId = randomUUID();
    const boundaryName = 'b'.repeat(120);

    const response = await request(harness.app.getHttpServer())
      .post('/api/v1/promo-code-configs')
      .set(...authHeader())
      .send({
        tenantId,
        actorId,
        name: boundaryName,
        codeLength: 8,
        characterSet: 'ALPHANUMERIC',
        rewardValueType: 'FIXED_AMOUNT',
        rewardValue: 5,
        rewardUnit: 'USD',
      });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe(boundaryName);
  });

  // Regression guard for T-PC-046 — filed by this task mid-audit (see
  // plan/reports/T-PC-041-security-checklist.md for the full finding) after reproducing an
  // oversized customerId hitting the DB's own varchar(120) constraint and surfacing as a gRPC
  // UNKNOWN/"Internal server error" instead of the documented FAILED/INVALID_REQUEST business
  // outcome (`03-GRPC-CONTRACT.md` §5). T-PC-046 landed its own fix (a `.max(120)` bound on
  // `customerId` in `generation-request.types.ts`, matching the DB column) independently, under
  // its own review — this test confirms the now-fixed, real client-observed behaviour rather than
  // asserting it happened without checking (`AGENT-PROTOCOL.md` §3).
  it('T-PC-046 regression: an oversized customerId over gRPC returns FAILED/INVALID_REQUEST, never a protocol-level fault', async () => {
    const { tenantId, bindRefId } = await harness.createBoundConfig({ codePrefix: 'OVSZ-' });
    const client = harness.allowedGrpcClient();
    const oversizedCustomerId = 'x'.repeat(500);

    const response = await callGenerateCode(client, {
      correlationId: randomUUID(),
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: oversizedCustomerId,
      merchantId: '',
    });

    expect(response.status).toBe('FAILED');
    expect(response.errorCode).toBe('INVALID_REQUEST');
    expect(response.errorMessage.toLowerCase()).toContain('customerid');
    // Never a raw DB error leaking internal schema detail into a caller-facing message.
    expect(response.errorMessage).not.toContain('character varying');
    client.close();

    // The server is still alive and correctly serving other requests right after — proves this
    // was a normal business-outcome response, not a wedged/crashed process (same discipline as
    // kafka-poison-message.spec.ts's own TC-7 resilience check, applied to the gRPC transport).
    const controlResponse = await callGenerateCode(harness.allowedGrpcClient(), {
      correlationId: randomUUID(),
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-after-oversized',
      merchantId: '',
    });
    expect(controlResponse.status).toBe('SUCCESS');
  });
});
