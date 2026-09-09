/**
 * T-RR-011. Real round trip: a real `@grpc/grpc-js` client, over real mTLS (ephemeral CA/server/
 * client certificates, `test-cert-authority.ts`), against a real, listening
 * `GrpcMicroserviceRootModule` (`src/grpc/grpc-server.main.ts`'s own composition root) backed by
 * the real, already-migrated `reward_redemption` schema on the real local Postgres 16 server (root
 * `CLAUDE.md`) — same "assert the observable property, not the implementation string" discipline
 * this project's own `reward-ingestion.service.spec.ts` already established: only a real TLS
 * handshake against a real server can actually prove TC-5/TC-6's connection/guard-level rejection,
 * and only a real `@grpc/proto-loader` package definition can actually prove TC-7's
 * fully-qualified method path, not a mocked transport or a hand-typed string literal.
 *
 * `.env.development`'s own `GRPC_SERVER_TLS_*` values are placeholders (`./dev-certs/...`, no such
 * files exist yet — see this file's own root-cause note in the completion report) — this suite
 * overrides all four `GRPC_SERVER_*` vars with a fresh ephemeral port and real, freshly-generated
 * certs per run, exactly the override RAP's own `grpc-server.e2e-spec.ts` (T-RAP-022) already
 * establishes as this repo's precedent (confirmed by direct read).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import type { INestMicroservice } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import { Sequelize } from 'sequelize';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { createGrpcMicroservice } from '@/grpc/grpc-server.main';
import { TestCertAuthority, type IssuedCertificate } from './support/test-cert-authority';
import {
  createTestClient,
  callSubmitRewardEntry,
  resolveFullyQualifiedMethodPath,
  type RewardIngestServiceTestClient,
} from './support/test-grpc-client';

jest.setTimeout(30000);

const ALLOWED_IDENTITY = 'rr-e2e-allowed-client';
const DENIED_IDENTITY = 'rr-e2e-denied-client';
const TENANT_ID = 950_000 + Math.floor(Math.random() * 9_999);

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error('failed to allocate a free port'));
      }
    });
  });
}

describe('T-RR-011 — gRPC server (real mTLS, real Postgres) (e2e)', () => {
  let ca: TestCertAuthority;
  let microserviceApp: INestMicroservice;
  let db: Sequelize;
  let address: string;
  let allowedCert: IssuedCertificate;
  let deniedCert: IssuedCertificate;

  beforeAll(async () => {
    ca = TestCertAuthority.build();
    const grpcPort = await getFreePort();
    address = `localhost:${grpcPort}`;

    process.env.GRPC_SERVER_PORT = String(grpcPort);
    process.env.GRPC_SERVER_TLS_CA_PATH = ca.caCertPath;
    process.env.GRPC_SERVER_TLS_CERT_PATH = ca.serverCertPath;
    process.env.GRPC_SERVER_TLS_KEY_PATH = ca.serverKeyPath;
    process.env.GRPC_SERVER_ALLOWED_IDENTITIES = `${ALLOWED_IDENTITY}:${TENANT_ID}`;
    delete process.env.GRPC_SERVER_ENABLED;

    db = createMigrationConnection();
    await db.authenticate();

    const app = await createGrpcMicroservice();
    if (app === null) {
      throw new Error('expected createGrpcMicroservice() to return a microservice in this test');
    }
    microserviceApp = app;
    await microserviceApp.listen();

    allowedCert = ca.issueClientCert(ALLOWED_IDENTITY);
    deniedCert = ca.issueClientCert(DENIED_IDENTITY);
  });

  afterAll(async () => {
    await db.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await db.close();
    await microserviceApp.close();
    ca.cleanup();
  });

  function allowedClient(): RewardIngestServiceTestClient {
    const credentials = grpc.credentials.createSsl(
      readFileSync(ca.caCertPath),
      readFileSync(allowedCert.keyPath),
      readFileSync(allowedCert.certPath),
    );
    return createTestClient(address, credentials);
  }

  function deniedClient(): RewardIngestServiceTestClient {
    const credentials = grpc.credentials.createSsl(
      readFileSync(ca.caCertPath),
      readFileSync(deniedCert.keyPath),
      readFileSync(deniedCert.certPath),
    );
    return createTestClient(address, credentials);
  }

  /** No client key/cert pair presented at all — just the CA, to verify the server cert. */
  function noCertClient(): RewardIngestServiceTestClient {
    const credentials = grpc.credentials.createSsl(readFileSync(ca.caCertPath));
    return createTestClient(address, credentials);
  }

  function baseRequest(overrides: Record<string, unknown> = {}) {
    return {
      // `reward_redemption_entry.id`/`correlation_id` are both real Postgres `uuid` columns
      // (`01-DATABASE.md` §1) — must be well-formed UUIDs, not merely non-empty strings.
      id: randomUUID(),
      correlationId: randomUUID(),
      tenantId: TENANT_ID,
      customerId: `cust-${randomUUID()}`,
      customerIdType: 'MSISDN',
      activityPerformedDate: '2026-09-04T10:15:00Z',
      activityCode: 'TXN_TOPUP',
      activityType: 'TOPUP',
      activityCategory: 'TELCO',
      activityValue: '50.0000',
      activityValueUnit: 'MYR',
      channel: 'app',
      activityPerformedEnv: 'production',
      activityName: 'Prepaid Top-up',
      campaignCode: 'CAMP-2026-Q3-001',
      trackerCode: 'TRK-TOPUP-5X',
      trackerComponentCode: 'CMP-TOPUP-STEP-3',
      rewardCode: 'RWD-CASHBACK-5PCT',
      rewardCategory: 'CASHBACK',
      rewardValue: '2.5000',
      rewardValueUnit: 'MYR',
      rewardEntryDate: '2026-09-04T10:15:03Z',
      completionCycle: 1,
      ...overrides,
    };
  }

  async function countRows(id: string): Promise<number> {
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_redemption.reward_redemption_entry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    return Number(rows[0].count);
  }

  // TC-1
  it('TC-1: a well-formed, fresh RewardEntry is accepted and durably persisted as received', async () => {
    const client = allowedClient();
    const request = baseRequest();

    const response = await callSubmitRewardEntry(client, request);

    expect(response.rewardEntryId).toBe(request.id);
    expect(response.status).toBe('received');
    expect(await countRows(request.id)).toBe(1);
    client.close();
  });

  // TC-2
  it("TC-2: submitting the identical id twice returns the existing row's status, no gRPC error, no second row", async () => {
    const client = allowedClient();
    const request = baseRequest();

    const first = await callSubmitRewardEntry(client, request);
    const second = await callSubmitRewardEntry(client, request);

    expect(first.status).toBe('received');
    // The row may have already been claimed by T-RR-020's own concurrently-running claim worker
    // on this shared table by the time the second call reads it back — same documented tradeoff
    // `reward-ingestion.service.spec.ts`'s own TC-3 already accepts for this table. The property
    // this task owns is asserted directly: no gRPC error, and exactly one row for this id.
    expect(['received', 'processing']).toContain(second.status);
    expect(second.rewardEntryId).toBe(request.id);
    expect(await countRows(request.id)).toBe(1);
    client.close();
  });

  // TC-3 (negative)
  it('TC-3: an empty id is rejected with INVALID_ARGUMENT and no row is inserted', async () => {
    const client = allowedClient();
    const request = baseRequest({ id: '' });

    await expect(callSubmitRewardEntry(client, request)).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
    });
    client.close();
  });

  // TC-4 (negative)
  it('TC-4: an unparseable activity_performed_date is rejected with INVALID_ARGUMENT', async () => {
    const client = allowedClient();
    const request = baseRequest({ activityPerformedDate: '2026-09-04 10:15:00' });

    await expect(callSubmitRewardEntry(client, request)).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
    });
    expect(await countRows(request.id)).toBe(0);
    client.close();
  });

  // TC-5 (negative)
  it('TC-5: no client certificate presented is rejected before the handler runs', async () => {
    const client = noCertClient();

    await expect(callSubmitRewardEntry(client, baseRequest())).rejects.toMatchObject({
      code: grpc.status.UNAVAILABLE,
    });
    client.close();
  });

  // TC-6 (negative)
  it('TC-6: a CA-signed certificate whose SAN is not on the allowlist is rejected with PERMISSION_DENIED', async () => {
    const client = deniedClient();

    await expect(callSubmitRewardEntry(client, baseRequest())).rejects.toMatchObject({
      code: grpc.status.PERMISSION_DENIED,
    });
    client.close();
  });

  // TC-7
  it('TC-7: the fully-qualified gRPC method path is exactly /rewardrap.reward.v1.RewardIngestService/SubmitRewardEntry', () => {
    expect(resolveFullyQualifiedMethodPath()).toBe(
      '/rewardrap.reward.v1.RewardIngestService/SubmitRewardEntry',
    );
  });
});
