/**
 * T-RAP-011. DI-wiring smoke test — same shape as `campaign-config-cache.module.spec.ts`'s own
 * precedent. `.compile()` alone does not invoke `OnModuleInit` (that needs `moduleRef.init()`),
 * so resolving `WatchStreamConsumer`/`ReconciliationPollerService` here never opens a real gRPC
 * stream or touches a real DB — this only proves every provider in the module's DI graph resolves
 * to the right class, nothing about runtime behaviour (covered by the other specs in this
 * directory).
 */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@/config/config.module';
import { InvalidationModule } from '@/modules/invalidation/invalidation.module';
import { WatchStreamConsumer } from '@/modules/invalidation/watch-stream.consumer';
import { ReconciliationPollerService } from '@/modules/invalidation/reconciliation-poller.service';
import { CampaignConfigCacheService } from '@/modules/campaign-cache/campaign-config-cache.service';
import { CampaignConfigClient } from '@/modules/campaign-cache/campaign-config.client';

describe('InvalidationModule', () => {
  it('provides and exports every public class this module owns', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, InvalidationModule],
    }).compile();

    expect(moduleRef.get(WatchStreamConsumer)).toBeInstanceOf(WatchStreamConsumer);
    expect(moduleRef.get(ReconciliationPollerService)).toBeInstanceOf(ReconciliationPollerService);
    // Reused, not duplicated, from CampaignConfigCacheModule (this module's own header).
    expect(moduleRef.get(CampaignConfigCacheService)).toBeInstanceOf(CampaignConfigCacheService);
    expect(moduleRef.get(CampaignConfigClient)).toBeInstanceOf(CampaignConfigClient);

    await moduleRef.close();
  });
});
