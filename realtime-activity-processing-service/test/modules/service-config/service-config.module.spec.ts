/**
 * T-RAP-013. DI-wiring smoke test — same shape as `encryption.module.spec.ts`'s own precedent
 * (T-RAP-012, same file-scope owner). `.compile()` alone does not invoke `OnModuleInit` (that
 * needs `moduleRef.init()`), so resolving `ServiceConfigResolverService` here never touches the
 * real DB.
 */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@/config/config.module';
import { ServiceConfigModule } from '@/modules/service-config/service-config.module';
import { ServiceConfigRepository } from '@/modules/service-config/service-config.repository';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';

describe('ServiceConfigModule', () => {
  it('provides and exports every public class this module owns', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, ServiceConfigModule],
    }).compile();

    expect(moduleRef.get(ServiceConfigRepository)).toBeInstanceOf(ServiceConfigRepository);
    expect(moduleRef.get(ServiceConfigResolverService)).toBeInstanceOf(
      ServiceConfigResolverService,
    );

    await moduleRef.close();
  });
});
