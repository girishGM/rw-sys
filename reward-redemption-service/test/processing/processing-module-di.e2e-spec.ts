/**
 * T-RR-055 — regression test for the defect this task fixes: `CampaignConfigClient` and
 * `CampaignConfigCache` were not constructible via real Nest DI. Every other spec under
 * `test/processing/**` constructs these classes directly with `new`, bypassing Nest's DI
 * container entirely — that's exactly why this defect went unnoticed until `T-RR-054` tried to
 * import `ProcessingModule` into a real `AppModule`/`Test.createTestingModule` graph.
 *
 * Root cause (see `campaign-config.client.ts`'s and `campaign-config.cache.ts`'s own constructor
 * headers for the full mechanism): both classes take a plain-interface- or array-typed
 * constructor parameter with a JS default value, intended purely as a "no explicit override"
 * fallback for direct `new` construction/tests. Neither type has a runtime provider token Nest's
 * automatic constructor-injection can resolve, and without `@Optional()` on that parameter, Nest
 * treats "no matching provider" as a hard failure and throws at module-compile time —
 * `"Nest can't resolve dependencies of the CampaignConfigClient (?)"` — before ever reaching the
 * constructor body, let alone its default value.
 *
 * Reproduced directly (recorded in this task's completion report): before the `@Optional()` fix,
 * `Test.createTestingModule({ imports: [ConfigModule, ProcessingModule] }).compile()` threw that
 * exact error for `CampaignConfigClient`'s options parameter, and — once that one was fixed in
 * isolation — threw the equivalent error for `CampaignConfigCache`'s `tenantIds` parameter
 * (`"argument Array at index [2] is available in the ProcessingModule module"`), confirming the
 * task file's own prediction that the same pattern would surface for both.
 */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@/config/config.module';
import { CampaignConfigCache } from '@/modules/processing/campaign-config.cache';
import { CampaignConfigClient } from '@/modules/processing/campaign-config.client';
import { ProcessingModule } from '@/modules/processing/processing.module';
import {
  RewardSystemResolutionService,
  TenantSchemaEnrichmentService,
} from '@/modules/processing/reward-system-resolution.service';

describe('T-RR-055 — ProcessingModule compiles via real Nest DI', () => {
  const originalTenantIds = process.env.PORTAL_CONFIG_TENANT_IDS;

  beforeAll(() => {
    // Matches the exact reproduction in the filed defect: PORTAL_CONFIG_TENANT_IDS set, nothing
    // else PORTAL_GRPC_*-related configured (so CampaignConfigClient falls back to its own
    // documented localhost:50051 default — never actually dialed by this test, since compiling
    // the module only constructs the grpc-js client object, it never issues an RPC).
    process.env.PORTAL_CONFIG_TENANT_IDS = '1,2';
  });

  afterAll(() => {
    if (originalTenantIds === undefined) {
      delete process.env.PORTAL_CONFIG_TENANT_IDS;
    } else {
      process.env.PORTAL_CONFIG_TENANT_IDS = originalTenantIds;
    }
  });

  it('TC-2/TC-3: compiles a real Test.createTestingModule graph and resolves all three providers', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, ProcessingModule],
    }).compile();

    try {
      expect(moduleRef.get(CampaignConfigClient)).toBeInstanceOf(CampaignConfigClient);
      expect(moduleRef.get(CampaignConfigCache)).toBeInstanceOf(CampaignConfigCache);
      expect(moduleRef.get(RewardSystemResolutionService)).toBeInstanceOf(
        RewardSystemResolutionService,
      );
      // T-RR-065: the fourth provider this module now exports — resolvable via real Nest DI,
      // same as the other three (its own `TenantSchemaConfigCache` dependency comes from
      // `TenantSchemaCacheModule`, already imported here for `ServiceConfigCache`).
      expect(moduleRef.get(TenantSchemaEnrichmentService)).toBeInstanceOf(
        TenantSchemaEnrichmentService,
      );
    } finally {
      await moduleRef.close();
    }
  });

  it('TC-4: a caller-supplied CampaignConfigClient options object is still honoured by direct construction (unchanged adjacent behaviour)', () => {
    const client = new CampaignConfigClient({ host: '127.0.0.1', port: 60999, timeoutMs: 1_234 });
    expect(client).toBeInstanceOf(CampaignConfigClient);
    client.onModuleDestroy();
  });

  it('TC-4: a caller-supplied tenantIds array is still honoured by direct CampaignConfigCache construction (unchanged adjacent behaviour)', () => {
    const client = new CampaignConfigClient({ host: '127.0.0.1', port: 60999, timeoutMs: 1_234 });
    const serviceConfigCache = { resolve: jest.fn().mockResolvedValue(300) } as never;
    const cache = new CampaignConfigCache(client, serviceConfigCache, [7, 8]);
    expect(cache).toBeInstanceOf(CampaignConfigCache);
    client.onModuleDestroy();
  });
});
