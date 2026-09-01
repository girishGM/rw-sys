/**
 * T-PC-041. Cross-cutting negative-authorization sweep for the mTLS gRPC transport
 * (`03-GRPC-CONTRACT.md` §3) — a real self-signed test CA + client certificate pair (never a
 * mocked SAN string), against a real, listening `GrpcMicroserviceRootModule`, per
 * `AGENT-PROTOCOL.md` §3's "assert the observable property" rule and this task's own
 * implementation note 4: only a real TLS handshake against a real server can prove a rejection is
 * the actual mTLS wiring at work, not a unit test of the comparison function alone.
 *
 * T-PC-031's own `grpc-server.e2e-spec.ts` already covers TC-5/TC-6/TC-7 (no cert / unlisted
 * identity / bearer-metadata-with-no-cert) for `GenerateCode` specifically, with real
 * infrastructure — confirmed by reading that file (not re-derived from prose). What it does not
 * cover, and what this file adds:
 *
 *  1. The identical no-cert / unlisted-identity probes repeated against
 *     `ListActivePromoCodeConfigs` — `MtlsGuard` is applied at the *class* level
 *     (`@UseGuards(MtlsGuard)` on `PromoCodeController`), so architecturally both RPCs are
 *     covered, but T-PC-031's own suite only ever calls this RPC with `allowedClient()` (TC-8/
 *     TC-9) — R5 ("every new... RPC... gets a negative-authorisation test") applied per-RPC, not
 *     assumed transitively from the class-level decorator.
 *  2. A cross-tenant `GenerateCode` probe (TC-6 in this task's own file) — a valid, allowlisted
 *     identity requesting a `tenant_id` that never bound the `bind_ref_id` in question, proving
 *     `CONFIG_NOT_BOUND` is returned and no other tenant's binding ever leaks through, independent
 *     of whichever binding *does* exist for a different tenant at that same `bind_ref_id` value —
 *     a stronger version of T-PC-031's own TC-2 (which only tests "no binding exists at all").
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
import { createAppTestConnection } from '../config/support/app-connection';
import { TestCertAuthority, type IssuedCertificate } from '../grpc/support/test-cert-authority';
import {
  createTestClient,
  callGenerateCode,
  callListActivePromoCodeConfigs,
  type PromoCodeServiceTestClient,
} from '../grpc/support/test-grpc-client';

jest.setTimeout(30_000);

const ALLOWED_IDENTITY = 'reward-redemption-service-t-pc-041';
const DENIED_IDENTITY = 'not-allowed-service-t-pc-041';

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

describe('T-PC-041 — gRPC negative-authorization sweep (real mTLS, real Postgres) (e2e)', () => {
  let ca: TestCertAuthority;
  let microserviceApp: INestMicroservice;
  let sequelize: Sequelize;
  let promoCodeConfigRepository: PromoCodeConfigRepository;
  let bindingService: CampaignBindingService;
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

    sequelize = createAppTestConnection();
    await sequelize.authenticate();

    allowedCert = ca.issueClientCert(ALLOWED_IDENTITY);
    deniedCert = ca.issueClientCert(DENIED_IDENTITY);

    const [row] = await sequelize.query<{ id: string }>(
      `INSERT INTO promo_code.grpc_service_identity (service_identity, description, created_by)
         VALUES (:identity, 'T-PC-041 negative-auth sweep', :actor) RETURNING id`,
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

  function clientWith(cert: IssuedCertificate): PromoCodeServiceTestClient {
    const credentials = grpc.credentials.createSsl(
      readFileSync(ca.caCertPath),
      readFileSync(cert.keyPath),
      readFileSync(cert.certPath),
    );
    return createTestClient(address, credentials);
  }

  function allowedClient(): PromoCodeServiceTestClient {
    return clientWith(allowedCert);
  }

  function deniedClient(): PromoCodeServiceTestClient {
    return clientWith(deniedCert);
  }

  function noCertClient(): PromoCodeServiceTestClient {
    const credentials = grpc.credentials.createSsl(readFileSync(ca.caCertPath));
    return createTestClient(address, credentials);
  }

  async function seedBoundConfig(): Promise<{ tenantId: string; bindRefId: string }> {
    const tenantId = freshTenant();
    const actorId = randomUUID();
    const config = await promoCodeConfigRepository.create(tenantId, {
      merchantId: null,
      name: `t-pc-041 grpc-negative-auth ${randomUUID()}`,
      codePrefix: 'GNA-',
      codePostfix: null,
      codeLength: 10,
      characterSet: 'ALPHANUMERIC',
      excludeAmbiguousChars: true,
      rewardValueType: 'FIXED_AMOUNT',
      rewardValue: 10,
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

  // TC-4
  it('TC-4: GenerateCode with no client certificate is rejected before the handler runs', async () => {
    const client = noCertClient();
    await expect(
      callGenerateCode(client, {
        correlationId: randomUUID(),
        tenantId: randomUUID(),
        bindLevel: 'CAMPAIGN',
        bindRefId: randomUUID(),
        customerId: 'cust-tc4',
        merchantId: '',
      }),
    ).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
    client.close();
  });

  // TC-4 (per-RPC repeat, per this file's own header note 1)
  it('TC-4b: ListActivePromoCodeConfigs with no client certificate is rejected before the handler runs', async () => {
    const client = noCertClient();
    await expect(
      callListActivePromoCodeConfigs(client, { tenantId: randomUUID(), merchantId: '' }),
    ).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
    client.close();
  });

  // TC-5
  it('TC-5: GenerateCode with a valid cert from an unlisted identity is PERMISSION_DENIED', async () => {
    const client = deniedClient();
    await expect(
      callGenerateCode(client, {
        correlationId: randomUUID(),
        tenantId: randomUUID(),
        bindLevel: 'CAMPAIGN',
        bindRefId: randomUUID(),
        customerId: 'cust-tc5',
        merchantId: '',
      }),
    ).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    client.close();
  });

  // TC-5 (per-RPC repeat)
  it('TC-5b: ListActivePromoCodeConfigs with a valid cert from an unlisted identity is PERMISSION_DENIED', async () => {
    const client = deniedClient();
    await expect(
      callListActivePromoCodeConfigs(client, { tenantId: randomUUID(), merchantId: '' }),
    ).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    client.close();
  });

  // TC-6 — the stronger cross-tenant probe this file's own header describes: tenant A really has
  // an ACTIVE binding at bindRefId; tenant B (a different, allowlisted-identity caller) requests
  // that exact same bindRefId under its own tenantId and must never see tenant A's binding.
  it('TC-6: cross-tenant GenerateCode never resolves another tenant’s binding at the same bindRefId', async () => {
    const { tenantId: tenantA, bindRefId } = await seedBoundConfig();
    const tenantB = freshTenant();
    const client = allowedClient();

    const response = await callGenerateCode(client, {
      correlationId: randomUUID(),
      tenantId: tenantB,
      bindLevel: 'CAMPAIGN',
      bindRefId, // tenant A's own bindRefId, deliberately reused under tenant B's id.
      customerId: 'cust-tc6',
      merchantId: '',
    });

    expect(response.status).toBe('FAILED');
    expect(response.errorCode).toBe('CONFIG_NOT_BOUND');
    // Never any of tenant A's issued fields leaking through on the "FAILED" response.
    expect(response.promoCodeId).toBe('');
    expect(response.code).toBe('');

    // The row-level proof: no promo_code was ever issued for tenant B off tenant A's binding.
    const rows = await sequelize.query(
      `SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantB`,
      { type: QueryTypes.SELECT, replacements: { tenantB } },
    );
    expect(rows).toHaveLength(0);
    expect(tenantA).not.toBe(tenantB);
    client.close();
  });

  // TC-6 (per-RPC repeat): the read-only listing surface is scoped by tenant_id identically —
  // tenant B's ListActivePromoCodeConfigs call must never return tenant A's config summary.
  it('TC-6b: ListActivePromoCodeConfigs never returns another tenant’s config summaries', async () => {
    const tenantA = freshTenant();
    const actorId = randomUUID();
    const configA = await promoCodeConfigRepository.create(tenantA, {
      merchantId: null,
      name: `t-pc-041 tenant-a-only ${randomUUID()}`,
      codePrefix: null,
      codePostfix: null,
      codeLength: 8,
      characterSet: 'NUMERIC',
      excludeAmbiguousChars: false,
      rewardValueType: 'POINTS',
      rewardValue: 50,
      rewardUnit: 'pts',
      maxRedemptionsPerCode: 1,
      codeExpiryDays: null,
      createdBy: actorId,
    });
    const tenantB = freshTenant();
    const client = allowedClient();

    const response = await callListActivePromoCodeConfigs(client, {
      tenantId: tenantB,
      merchantId: '',
    });

    const ids = (response.configs ?? []).map((c) => c.id);
    expect(ids).not.toContain(configA.id);
    client.close();
  });
});
