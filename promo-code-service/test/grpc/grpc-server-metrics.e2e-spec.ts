/**
 * T-PC-048. Real round trip proving the fix for the defect T-PC-042 reported and could not close
 * itself (R8): before this task, `GrpcMicroserviceRootModule` bootstrapped a gRPC-only listener
 * (`NestFactory.createMicroservice`) whose own `PromoCodeGenerationService` instance was never
 * wrapped by `GenerationLatencyInstrumentation` (`GrpcServerModule` never imported `MetricsModule`)
 * and, even after wrapping it, had no HTTP surface at all to serve a scrapable `GET /metrics` from
 * — so `codes_generated_total`/`promo_code_generation_duration_seconds` never moved for the real
 * gRPC generation path this process alone actually serves in production (`grpc-server.module.ts`'s
 * and `grpc-server.main.ts`'s own T-PC-048 notes explain both halves of the fix in full).
 *
 * Boots `createGrpcHybridApp()` directly — the exact exported building block
 * `grpc-server.main.ts`'s own real `bootstrap()` calls, real mTLS (`TestCertAuthority`, same
 * discipline `grpc-server.e2e-spec.ts`, T-PC-031, already established) against the real,
 * already-migrated `promo_code` schema (root `CLAUDE.md`) — same "assert the observable property,
 * not the implementation string" discipline that file's own header cites (`AGENT-PROTOCOL.md` §3):
 * only a real scrape of a real, listening process can actually prove this, not a mocked transport
 * or a direct `MetricsService.render()` call bypassing the HTTP surface entirely.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import request from 'supertest';
import { createGrpcHybridApp } from '@/grpc/grpc-server.main';
import { PromoCodeConfigRepository } from '@/modules/promo-code-config/promo-code-config.repository';
import { CampaignBindingService } from '@/modules/campaign-binding/campaign-binding.service';
import { createAppTestConnection } from '../config/support/app-connection';
import { TestCertAuthority, type IssuedCertificate } from './support/test-cert-authority';
import {
  createTestClient,
  callGenerateCode,
  type PromoCodeServiceTestClient,
} from './support/test-grpc-client';

jest.setTimeout(30000);

const ALLOWED_IDENTITY = 'reward-redemption-service-t-pc-048';

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

/** `promo_code_codes_generated_total{transport="GRPC",outcome="SUCCESS"} N` — 0 if the line is
 * entirely absent (no observation recorded yet for that label combination). */
function parseCodesGeneratedTotal(text: string, outcome: 'SUCCESS' | 'FAILED'): number {
  const match = text.match(
    new RegExp(
      `promo_code_codes_generated_total\\{transport="GRPC",outcome="${outcome}"\\} (\\d+)`,
    ),
  );
  return match ? Number(match[1]) : 0;
}

function parseGenerationDurationCount(text: string): number {
  const match = text.match(
    /promo_code_generation_duration_seconds_count\{transport="GRPC"\} (\d+)/,
  );
  return match ? Number(match[1]) : 0;
}

describe('T-PC-048 — gRPC process own GET /metrics (real mTLS, real Postgres) (e2e)', () => {
  let ca: TestCertAuthority;
  let app: INestApplication;
  let sequelize: Sequelize;
  let promoCodeConfigRepository: PromoCodeConfigRepository;
  let bindingService: CampaignBindingService;
  let address: string;
  let allowedCert: IssuedCertificate;
  const tenantIds: string[] = [];
  const serviceIdentityIds: string[] = [];

  beforeAll(async () => {
    ca = TestCertAuthority.build();
    const grpcPort = await getFreePort();
    const metricsPort = await getFreePort();
    address = `localhost:${grpcPort}`;

    process.env.GRPC_PORT = String(grpcPort);
    process.env.GRPC_TLS_CA_PATH = ca.caCertPath;
    process.env.GRPC_TLS_CERT_PATH = ca.serverCertPath;
    process.env.GRPC_TLS_KEY_PATH = ca.serverKeyPath;
    process.env.GRPC_METRICS_PORT = String(metricsPort);
    delete process.env.GRPC_SERVER_ENABLED;
    delete process.env.GRPC_METRICS_ENABLED;

    const created = await createGrpcHybridApp();
    if (created === null) {
      throw new Error('expected createGrpcHybridApp() to return an app in this test');
    }
    app = created.app;
    await app.startAllMicroservices();
    await app.listen(metricsPort);

    promoCodeConfigRepository = app.get(PromoCodeConfigRepository);
    bindingService = app.get(CampaignBindingService);

    sequelize = createAppTestConnection();
    await sequelize.authenticate();

    allowedCert = ca.issueClientCert(ALLOWED_IDENTITY);
    const [row] = await sequelize.query<{ id: string }>(
      `INSERT INTO promo_code.grpc_service_identity (service_identity, description, created_by)
         VALUES (:identity, 'T-PC-048 e2e', :actor) RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: { identity: ALLOWED_IDENTITY, actor: randomUUID() },
      },
    );
    serviceIdentityIds.push(row.id);
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
        'DELETE FROM promo_code.promo_code_config WHERE tenant_id = :tenantId',
        { replacements: { tenantId } },
      );
    }
    if (serviceIdentityIds.length > 0) {
      await sequelize.query('DELETE FROM promo_code.grpc_service_identity WHERE id IN (:ids)', {
        type: QueryTypes.RAW,
        replacements: { ids: serviceIdentityIds },
      });
    }
    await sequelize.close();
    await app.close();
    ca.cleanup();
  });

  function freshTenant(): string {
    const id = randomUUID();
    tenantIds.push(id);
    return id;
  }

  function allowedClient(): PromoCodeServiceTestClient {
    const credentials = grpc.credentials.createSsl(
      readFileSync(ca.caCertPath),
      readFileSync(allowedCert.keyPath),
      readFileSync(allowedCert.certPath),
    );
    return createTestClient(address, credentials);
  }

  async function seedBoundConfig(): Promise<{ tenantId: string; bindRefId: string }> {
    const tenantId = freshTenant();
    const actorId = randomUUID();
    const config = await promoCodeConfigRepository.create(tenantId, {
      merchantId: null,
      name: `t-pc-048 e2e config ${randomUUID()}`,
      codePrefix: 'MET-',
      codePostfix: null,
      codeLength: 10,
      characterSet: 'ALPHANUMERIC',
      excludeAmbiguousChars: true,
      rewardValueType: 'FIXED_AMOUNT',
      rewardValue: 5,
      rewardUnit: 'USD',
      maxRedemptionsPerCode: 1,
      codeExpiryDays: 30,
      createdBy: actorId,
    });
    const bindRefId = randomUUID();
    await bindingService.bind({
      promoCodeConfigId: config.id,
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      boundBy: actorId,
    });
    return { tenantId, bindRefId };
  }

  // TC-2/TC-3 (this task's own numbering): reverting either `grpc-server.module.ts`'s
  // `MetricsModule` import or `grpc-server.main.ts`'s hybrid-app bootstrap reproduces TC-1 (the
  // reported symptom) — this same GET /metrics scrape would then either never see the counter
  // move (module not imported) or fail to connect at all (no HTTP listener). Proven by reverting
  // each change locally and re-running this file: both reproduce a red test (see completion
  // report).
  it("T-PC-048 TC-2: a real gRPC GenerateCode call increments this process's own codes_generated_total, scrapable via this same process's real GET /metrics", async () => {
    const before = await request(app.getHttpServer()).get('/metrics');
    expect(before.status).toBe(200);
    expect(before.headers['content-type']).toContain('text/plain');
    const beforeSuccess = parseCodesGeneratedTotal(before.text, 'SUCCESS');
    const beforeDurationCount = parseGenerationDurationCount(before.text);

    const { tenantId, bindRefId } = await seedBoundConfig();
    const client = allowedClient();
    const response = await callGenerateCode(client, {
      correlationId: randomUUID(),
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-t-pc-048',
      merchantId: '',
    });
    expect(response.status).toBe('SUCCESS');
    client.close();

    const after = await request(app.getHttpServer()).get('/metrics');
    expect(after.status).toBe(200);
    const afterSuccess = parseCodesGeneratedTotal(after.text, 'SUCCESS');
    const afterDurationCount = parseGenerationDurationCount(after.text);

    expect(afterSuccess).toBe(beforeSuccess + 1);
    expect(afterDurationCount).toBe(beforeDurationCount + 1);
  });

  // Adjacent behaviour: a FAILED generation (CONFIG_NOT_BOUND) is still counted, labelled FAILED —
  // the instrumentation wraps every outcome, not just SUCCESS.
  it('adjacent: a FAILED gRPC generation is counted under outcome="FAILED", not silently dropped', async () => {
    const before = await request(app.getHttpServer()).get('/metrics');
    const beforeFailed = parseCodesGeneratedTotal(before.text, 'FAILED');

    const client = allowedClient();
    const response = await callGenerateCode(client, {
      correlationId: randomUUID(),
      tenantId: randomUUID(),
      bindLevel: 'CAMPAIGN',
      bindRefId: randomUUID(),
      customerId: 'cust-t-pc-048-failed',
      merchantId: '',
    });
    expect(response.status).toBe('FAILED');
    client.close();

    const after = await request(app.getHttpServer()).get('/metrics');
    const afterFailed = parseCodesGeneratedTotal(after.text, 'FAILED');
    expect(afterFailed).toBe(beforeFailed + 1);
  });
});
