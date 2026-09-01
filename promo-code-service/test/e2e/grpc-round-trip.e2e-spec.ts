/**
 * T-PC-040. Full gRPC round trip: a real `@grpc/grpc-js` client, over a real mTLS handshake
 * (ephemeral CA/server/client certificates, `test/grpc/support/test-cert-authority.ts`), against
 * the real, listening `GrpcMicroserviceRootModule` (`src/grpc/grpc-server.main.ts`, T-PC-031),
 * backed by the real, already-migrated `promo_code` schema (root `CLAUDE.md`). Same
 * "assert the observable property, not the implementation string" discipline
 * `AGENT-PROTOCOL.md` §3 requires: only a real TLS handshake against a real running server can
 * actually prove TC-7's connection-level rejection, not a mocked transport.
 *
 * **Deviation from the task file's literal Verification step 1 command (`npm run test:e2e`)**: no
 * `test:e2e` script exists in `package.json` — same precedent as every sibling spec in this suite
 * (see `kafka-round-trip.e2e-spec.ts`'s own header for the full explanation).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { QueryTypes } from 'sequelize';
import { callGenerateCode } from '../grpc/support/test-grpc-client';
import { E2ETestHarness } from './setup/e2e-test-app';

jest.setTimeout(60_000);

describe('T-PC-040 — gRPC round trip (real mTLS, real Postgres) (e2e)', () => {
  let harness: E2ETestHarness;

  beforeAll(async () => {
    harness = await E2ETestHarness.create();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  // TC-2
  it('TC-2: GenerateCode over a real mTLS handshake returns SUCCESS and a real promo_code row', async () => {
    const { tenantId, bindRefId } = await harness.createBoundConfig({
      codePrefix: 'GRPCE2E-',
      rewardValueType: 'PERCENTAGE',
      rewardValue: 20,
      rewardUnit: '%',
    });
    const client = harness.allowedGrpcClient();
    const correlationId = randomUUID();

    const response = await callGenerateCode(client, {
      correlationId,
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-e2e-tc2',
      merchantId: '',
    });

    expect(response.status).toBe('SUCCESS');
    expect(response.code.startsWith('GRPCE2E-')).toBe(true);
    expect(response.rewardValueType).toBe('PERCENTAGE');
    expect(response.rewardValue).toBe('20.0000');
    expect(response.rewardUnit).toBe('%');
    expect(response.errorCode).toBe('');
    client.close();

    const rows = await harness.sequelize.query<{ id: string; code: string }>(
      `SELECT id, code FROM promo_code.promo_code WHERE tenant_id = :tenantId AND correlation_id = :correlationId`,
      { type: QueryTypes.SELECT, replacements: { tenantId, correlationId } },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(response.promoCodeId);
    expect(rows[0].code).toBe(response.code);
  });

  // TC-7
  it('TC-7: GenerateCode with no client certificate is rejected before the handler runs', async () => {
    const client = harness.noCertGrpcClient();

    await expect(
      callGenerateCode(client, {
        correlationId: randomUUID(),
        tenantId: randomUUID(),
        bindLevel: 'CAMPAIGN',
        bindRefId: randomUUID(),
        customerId: 'cust-e2e-tc7',
        merchantId: '',
      }),
    ).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
    client.close();
  });
});
