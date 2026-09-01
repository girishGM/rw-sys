/**
 * T-PC-031. Real round trip: a real `@grpc/grpc-js` client, over real mTLS (ephemeral CA/server/
 * client certificates, `test-cert-authority.ts`), against a real, listening `GrpcMicroserviceRootModule`
 * (`src/grpc/grpc-server.main.ts`'s own composition root) backed by the real, already-migrated
 * `promo_code` schema on the real Postgres 16 server (root `CLAUDE.md`) — same "assert the
 * observable property, not the implementation string" discipline `promo-code-config.controller.spec.ts`
 * (T-PC-011) and `promo-code-generation.e2e-spec.ts` (T-PC-021) already established for this
 * project (`AGENT-PROTOCOL.md` §3): only a real TLS handshake against a real server can actually
 * prove TC-5/TC-6/TC-7's connection-level/guard-level rejections, not a mocked transport.
 *
 * Deviation from the task file's literal Verification step 5 command (`npm run test:e2e --
 * grpc-server`): no `test:e2e` script exists in `package.json` (same precedent T-PC-011/T-PC-012/
 * T-PC-021 already established) — `npm test -- grpc` runs this file via the single `testRegex`
 * that already matches both `.spec.ts` and `.e2e-spec.ts`.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import type { INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as grpc from '@grpc/grpc-js';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { GrpcMicroserviceRootModule } from '@/grpc/grpc-server.main';
import { buildGrpcMicroserviceOptions } from '@/grpc/grpc-server.bootstrap';
import { PromoCodeConfigRepository } from '@/modules/promo-code-config/promo-code-config.repository';
import { CampaignBindingService } from '@/modules/campaign-binding/campaign-binding.service';
import { PromoCodeGenerationService } from '@/modules/generation/promo-code-generation.service';
import { createAppTestConnection } from '../config/support/app-connection';
import { TestCertAuthority, type IssuedCertificate } from './support/test-cert-authority';
import {
  createTestClient,
  callGenerateCode,
  callListActivePromoCodeConfigs,
  type PromoCodeServiceTestClient,
} from './support/test-grpc-client';

jest.setTimeout(30000);

const ALLOWED_IDENTITY = 'reward-redemption-service-test';
const DENIED_IDENTITY = 'not-allowed-service-test';

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

describe('T-PC-031 — gRPC server (real mTLS, real Postgres) (e2e)', () => {
  let ca: TestCertAuthority;
  let microserviceApp: INestMicroservice;
  let sequelize: Sequelize;
  let promoCodeConfigRepository: PromoCodeConfigRepository;
  let bindingService: CampaignBindingService;
  let generationService: PromoCodeGenerationService;
  let address: string;
  let allowedCert: IssuedCertificate;
  let deniedCert: IssuedCertificate;
  const tenantIds: string[] = [];
  const serviceIdentityIds: string[] = [];

  beforeAll(async () => {
    ca = TestCertAuthority.build();
    const port = await getFreePort();
    address = `localhost:${port}`;

    process.env.GRPC_PORT = String(port);
    process.env.GRPC_TLS_CA_PATH = ca.caCertPath;
    process.env.GRPC_TLS_CERT_PATH = ca.serverCertPath;
    process.env.GRPC_TLS_KEY_PATH = ca.serverKeyPath;
    delete process.env.GRPC_SERVER_ENABLED;

    const options = buildGrpcMicroserviceOptions();
    if (options === null) {
      throw new Error('expected buildGrpcMicroserviceOptions() to return options in this test');
    }
    microserviceApp = await NestFactory.createMicroservice(GrpcMicroserviceRootModule, options);
    await microserviceApp.listen();

    promoCodeConfigRepository = microserviceApp.get(PromoCodeConfigRepository);
    bindingService = microserviceApp.get(CampaignBindingService);
    generationService = microserviceApp.get(PromoCodeGenerationService);

    sequelize = createAppTestConnection();
    await sequelize.authenticate();

    allowedCert = ca.issueClientCert(ALLOWED_IDENTITY);
    deniedCert = ca.issueClientCert(DENIED_IDENTITY);

    // Only `ALLOWED_IDENTITY` is seeded into the allowlist — `DENIED_IDENTITY` has a perfectly
    // valid, CA-signed certificate (TLS handshake succeeds) but is simply never granted (TC-6).
    const [row] = await sequelize.query<{ id: string }>(
      `INSERT INTO promo_code.grpc_service_identity (service_identity, description, created_by)
         VALUES (:identity, 'T-PC-031 e2e', :actor) RETURNING id`,
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
        `DELETE FROM promo_code.promo_code_config_audit
           WHERE promo_code_config_id IN (
             SELECT id FROM promo_code.promo_code_config WHERE tenant_id = :tenantId
           )`,
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
    await microserviceApp.close();
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

  function deniedClient(): PromoCodeServiceTestClient {
    const credentials = grpc.credentials.createSsl(
      readFileSync(ca.caCertPath),
      readFileSync(deniedCert.keyPath),
      readFileSync(deniedCert.certPath),
    );
    return createTestClient(address, credentials);
  }

  /** No client key/cert pair presented at all — just the CA, to verify the server cert. */
  function noCertClient(): PromoCodeServiceTestClient {
    const credentials = grpc.credentials.createSsl(readFileSync(ca.caCertPath));
    return createTestClient(address, credentials);
  }

  async function seedBoundConfig(
    overrides: Partial<{
      rewardValueType: 'FIXED_AMOUNT' | 'PERCENTAGE' | 'POINTS';
      rewardValue: number;
      rewardUnit: string;
      codeExpiryDays: number | null;
    }> = {},
  ): Promise<{ tenantId: string; bindRefId: string; configId: string }> {
    const tenantId = freshTenant();
    const actorId = randomUUID();
    const config = await promoCodeConfigRepository.create(tenantId, {
      merchantId: null,
      name: `t-pc-031 e2e config ${randomUUID()}`,
      codePrefix: 'GRPC-',
      codePostfix: null,
      codeLength: 10,
      characterSet: 'ALPHANUMERIC',
      excludeAmbiguousChars: true,
      rewardValueType: overrides.rewardValueType ?? 'FIXED_AMOUNT',
      rewardValue: overrides.rewardValue ?? 10,
      rewardUnit: overrides.rewardUnit ?? 'USD',
      maxRedemptionsPerCode: 1,
      codeExpiryDays: overrides.codeExpiryDays ?? 30,
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
    return { tenantId, bindRefId, configId: config.id };
  }

  // TC-1
  it('TC-1: valid cert + resolvable binding returns SUCCESS with a decimal-string rewardValue', async () => {
    const { tenantId, bindRefId } = await seedBoundConfig({ rewardValue: 12.5 });
    const client = allowedClient();

    const response = await callGenerateCode(client, {
      correlationId: randomUUID(),
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-tc1',
      merchantId: '',
    });

    expect(response.status).toBe('SUCCESS');
    expect(response.promoCodeId.length).toBeGreaterThan(0);
    expect(response.code.startsWith('GRPC-')).toBe(true);
    expect(response.rewardValueType).toBe('FIXED_AMOUNT');
    expect(response.rewardValue).toBe('12.5000');
    expect(typeof response.rewardValue).toBe('string');
    expect(response.rewardUnit).toBe('USD');
    expect(response.expiresAt.length).toBeGreaterThan(0);
    expect(response.errorCode).toBe('');
    client.close();
  });

  // TC-2
  it('TC-2: unbound bind_ref_id returns FAILED / CONFIG_NOT_BOUND', async () => {
    const tenantId = freshTenant();
    const client = allowedClient();

    const response = await callGenerateCode(client, {
      correlationId: randomUUID(),
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId: randomUUID(),
      customerId: 'cust-tc2',
      merchantId: '',
    });

    expect(response.status).toBe('FAILED');
    expect(response.errorCode).toBe('CONFIG_NOT_BOUND');
    client.close();
  });

  // TC-3
  it("TC-3: an archived config's binding returns FAILED / CONFIG_INACTIVE", async () => {
    const { tenantId, bindRefId, configId } = await seedBoundConfig();
    await promoCodeConfigRepository.archive(tenantId, configId, randomUUID());
    const client = allowedClient();

    const response = await callGenerateCode(client, {
      correlationId: randomUUID(),
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-tc3',
      merchantId: '',
    });

    expect(response.status).toBe('FAILED');
    expect(response.errorCode).toBe('CONFIG_INACTIVE');
    client.close();
  });

  // TC-4
  it('TC-4: retrying with the same correlation_id returns the same promo_code_id/code, no second row', async () => {
    const { tenantId, bindRefId } = await seedBoundConfig();
    const client = allowedClient();
    const correlationId = randomUUID();
    const request = {
      correlationId,
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-tc4',
      merchantId: '',
    };

    const first = await callGenerateCode(client, request);
    const second = await callGenerateCode(client, request);

    expect(second.promoCodeId).toBe(first.promoCodeId);
    expect(second.code).toBe(first.code);

    const rows = await sequelize.query(
      'SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantId AND correlation_id = :correlationId',
      { type: QueryTypes.SELECT, replacements: { tenantId, correlationId } },
    );
    expect(rows).toHaveLength(1);
    client.close();
  });

  // TC-5
  it('TC-5: no client certificate presented is rejected before the handler runs', async () => {
    const client = noCertClient();

    await expect(
      callGenerateCode(client, {
        correlationId: randomUUID(),
        tenantId: randomUUID(),
        bindLevel: 'CAMPAIGN',
        bindRefId: randomUUID(),
        customerId: 'cust-tc5',
        merchantId: '',
      }),
    ).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
    client.close();
  });

  // TC-6
  it('TC-6: a client cert not on the allowlist is rejected with PERMISSION_DENIED', async () => {
    const client = deniedClient();

    await expect(
      callGenerateCode(client, {
        correlationId: randomUUID(),
        tenantId: randomUUID(),
        bindLevel: 'CAMPAIGN',
        bindRefId: randomUUID(),
        customerId: 'cust-tc6',
        merchantId: '',
      }),
    ).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    client.close();
  });

  // TC-7
  it('TC-7: a bearer-token metadata header with no client certificate is rejected the same way as no credential at all', async () => {
    const client = noCertClient();
    const metadata = new grpc.Metadata();
    metadata.set('authorization', 'Bearer some-portal-session-jwt');

    await new Promise<void>((resolve, reject) => {
      client.GenerateCode(
        {
          correlationId: randomUUID(),
          tenantId: randomUUID(),
          bindLevel: 'CAMPAIGN',
          bindRefId: randomUUID(),
          customerId: 'cust-tc7',
          merchantId: '',
        },
        metadata,
        (error) => {
          try {
            expect(error).toBeTruthy();
            expect(error?.code).toBe(grpc.status.UNAVAILABLE);
            resolve();
          } catch (assertionError) {
            reject(assertionError);
          }
        },
      );
    });
    client.close();
  });

  // TC-8
  it('TC-8: ListActivePromoCodeConfigs returns the thin summary shape', async () => {
    const tenantId = freshTenant();
    const actorId = randomUUID();
    const config = await promoCodeConfigRepository.create(tenantId, {
      merchantId: null,
      name: `t-pc-031 tc8 ${randomUUID()}`,
      codePrefix: null,
      codePostfix: null,
      codeLength: 8,
      characterSet: 'NUMERIC',
      excludeAmbiguousChars: false,
      rewardValueType: 'POINTS',
      rewardValue: 100,
      rewardUnit: 'pts',
      maxRedemptionsPerCode: 1,
      codeExpiryDays: null,
      createdBy: actorId,
    });
    const client = allowedClient();

    const response = await callListActivePromoCodeConfigs(client, { tenantId, merchantId: '' });

    expect(response.configs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: config.id,
          name: config.name,
          rewardValueType: 'POINTS',
          rewardValue: '100.0000',
          rewardUnit: 'pts',
        }),
      ]),
    );
    client.close();
  });

  // TC-9
  it('TC-9: ListActivePromoCodeConfigs scoped by merchant_id returns tenant-wide + merchant-specific', async () => {
    const tenantId = freshTenant();
    const merchantId = randomUUID();
    const actorId = randomUUID();
    const tenantWide = await promoCodeConfigRepository.create(tenantId, {
      merchantId: null,
      name: `t-pc-031 tc9 tenant-wide ${randomUUID()}`,
      codePrefix: null,
      codePostfix: null,
      codeLength: 8,
      characterSet: 'NUMERIC',
      excludeAmbiguousChars: false,
      rewardValueType: 'FIXED_AMOUNT',
      rewardValue: 5,
      rewardUnit: 'USD',
      maxRedemptionsPerCode: 1,
      codeExpiryDays: null,
      createdBy: actorId,
    });
    const merchantScoped = await promoCodeConfigRepository.create(tenantId, {
      merchantId,
      name: `t-pc-031 tc9 merchant ${randomUUID()}`,
      codePrefix: null,
      codePostfix: null,
      codeLength: 8,
      characterSet: 'NUMERIC',
      excludeAmbiguousChars: false,
      rewardValueType: 'FIXED_AMOUNT',
      rewardValue: 5,
      rewardUnit: 'USD',
      maxRedemptionsPerCode: 1,
      codeExpiryDays: null,
      createdBy: actorId,
    });
    const client = allowedClient();

    const response = await callListActivePromoCodeConfigs(client, { tenantId, merchantId });

    const ids = response.configs.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([tenantWide.id, merchantScoped.id]));
    client.close();
  });

  // TC-13
  it('TC-13: a correlation_id resolved via a simulated Kafka-transport call is returned identically over gRPC', async () => {
    const { tenantId, bindRefId } = await seedBoundConfig();
    const correlationId = randomUUID();

    // Simulates the Kafka consumer (T-PC-030, not yet built) calling the exact same domain
    // method directly with `transport: 'KAFKA'` — proving the idempotency state
    // `PromoCodeGenerationService`/`promo_code.correlation_id` is shared across transports, not
    // per-adapter (`ARCHITECTURE.md` §6).
    const kafkaResult = await generationService.generateCode({
      correlationId,
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-tc13',
      merchantId: null,
      transport: 'KAFKA',
      activityContext: null,
    });
    expect(kafkaResult.status).toBe('SUCCESS');

    const client = allowedClient();
    const grpcResponse = await callGenerateCode(client, {
      correlationId,
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-tc13',
      merchantId: '',
    });

    expect(grpcResponse.status).toBe('SUCCESS');
    expect(grpcResponse.promoCodeId).toBe(
      kafkaResult.status === 'SUCCESS' ? kafkaResult.promoCodeId : undefined,
    );
    client.close();
  });

  // TC-14
  it('TC-14: a malformed bind_level returns FAILED / INVALID_REQUEST', async () => {
    const client = allowedClient();

    const response = await callGenerateCode(client, {
      correlationId: randomUUID(),
      tenantId: randomUUID(),
      bindLevel: 'NOT_A_REAL_LEVEL',
      bindRefId: randomUUID(),
      customerId: 'cust-tc14',
      merchantId: '',
    });

    expect(response.status).toBe('FAILED');
    expect(response.errorCode).toBe('INVALID_REQUEST');
    client.close();
  });

  // TC-15 (see also test/database/grpc-service-identity.spec.ts, T-PC-044's own regression suite,
  // for the full isolation proof) — this is a lighter, this-task-owned confirmation that the
  // table this guard actually queries at runtime lives in `promo_code`, not `reward_portal`.
  it('TC-15: grpc_service_identity is a promo_code-schema table, isolated from reward_portal', async () => {
    const rows = await sequelize.query<{ table_schema: string }>(
      `SELECT table_schema FROM information_schema.tables
         WHERE table_name = 'grpc_service_identity'`,
      { type: QueryTypes.SELECT },
    );
    expect(rows.map((r) => r.table_schema)).toEqual(['promo_code']);
  });

  // Adjacent behaviour: activity_context with a valid metadata_json is parsed and does not
  // itself cause a failure (metadata is passed through opaquely, per the proto's own comment).
  it('adjacent: a well-formed activity_context.metadata_json does not affect the SUCCESS outcome', async () => {
    const { tenantId, bindRefId } = await seedBoundConfig();
    const client = allowedClient();

    const response = await callGenerateCode(client, {
      correlationId: randomUUID(),
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-adjacent-metadata',
      merchantId: '',
      activityContext: { amount: '19.99', currency: 'USD', metadataJson: '{"source":"app"}' },
    });

    expect(response.status).toBe('SUCCESS');
    client.close();
  });

  // Adjacent behaviour: malformed metadata_json is INVALID_REQUEST, not a thrown/uncaught error.
  it('adjacent: malformed activity_context.metadata_json returns FAILED / INVALID_REQUEST', async () => {
    const { tenantId, bindRefId } = await seedBoundConfig();
    const client = allowedClient();

    const response = await callGenerateCode(client, {
      correlationId: randomUUID(),
      tenantId,
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-adjacent-bad-json',
      merchantId: '',
      activityContext: { amount: '', currency: '', metadataJson: '{not-json' },
    });

    expect(response.status).toBe('FAILED');
    expect(response.errorCode).toBe('INVALID_REQUEST');
    client.close();
  });

  // T-PC-047 TC-2 (this task's own numbering): before this task's fix, this same call emitted
  // `GrpcServerBootstrap`/`PromoCodeController` log lines as the default `ConsoleLogger`'s
  // human-readable text — `Logger.overrideLogger` was never called anywhere in this process, since
  // `GrpcMicroserviceRootModule`/`GrpcServerModule` never imported `LoggingModule` (see
  // `grpc-server.module.ts`'s own T-PC-047 note). Reproducing that would mean reverting this file's
  // `imports` array back to just `[PromoCodeGenerationModule, PromoCodeConfigModule]`; this test
  // proves the fixed state against this same real, listening `GrpcMicroserviceRootModule` process —
  // one JSON line, correlationId matching this call's own `correlation_id`, transport `'GRPC'`.
  it("T-PC-047 TC-2: GenerateCode's own structured log line carries this request's correlationId (real process)", async () => {
    const { tenantId, bindRefId } = await seedBoundConfig();
    const correlationId = randomUUID();
    const written: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write);

    try {
      const client = allowedClient();
      const response = await callGenerateCode(client, {
        correlationId,
        tenantId,
        bindLevel: 'CAMPAIGN',
        bindRefId,
        customerId: 'cust-t-pc-047',
        merchantId: '',
      });
      expect(response.status).toBe('SUCCESS');
      client.close();
    } finally {
      spy.mockRestore();
    }

    const entries = written
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .filter((entry) => entry.correlationId === correlationId);

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.transport).toBe('GRPC');
      expect(entry.rpc).toBe('GenerateCode');
      expect(typeof entry.level).toBe('string');
      expect(typeof entry.timestamp).toBe('string');
      expect(typeof entry.message).toBe('string');
    }
  });
});
