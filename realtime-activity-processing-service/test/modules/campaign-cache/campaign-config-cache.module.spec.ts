/**
 * T-RAP-010. DI-wiring smoke test — same shape as `idempotency.module.spec.ts`'s own precedent.
 * `.compile()` alone does not invoke `OnModuleInit` (that needs `moduleRef.init()`, which a real
 * `NestApplication` boot calls), so resolving `CampaignConfigCacheService` here never triggers
 * `bootstrap()` / never touches the network or a real DB — this only proves every provider in the
 * module's DI graph resolves to the right class, nothing about runtime behaviour (covered by the
 * other specs in this directory).
 */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@/config/config.module';
import { CampaignConfigCacheModule } from '@/modules/campaign-cache/campaign-config-cache.module';
import { CampaignConfigCacheService } from '@/modules/campaign-cache/campaign-config-cache.service';
import { CampaignConfigClient } from '@/modules/campaign-cache/campaign-config.client';
import {
  ActivityExternalCodeMapRepository,
  CampaignConfigSnapshotRepository,
} from '@/modules/campaign-cache/campaign-config-snapshot.repository';

describe('CampaignConfigCacheModule', () => {
  it('provides and exports every public class this module owns', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, CampaignConfigCacheModule],
    }).compile();

    expect(moduleRef.get(CampaignConfigCacheService)).toBeInstanceOf(CampaignConfigCacheService);
    expect(moduleRef.get(CampaignConfigClient)).toBeInstanceOf(CampaignConfigClient);
    expect(moduleRef.get(CampaignConfigSnapshotRepository)).toBeInstanceOf(
      CampaignConfigSnapshotRepository,
    );
    expect(moduleRef.get(ActivityExternalCodeMapRepository)).toBeInstanceOf(
      ActivityExternalCodeMapRepository,
    );

    await moduleRef.close();
  });
});
