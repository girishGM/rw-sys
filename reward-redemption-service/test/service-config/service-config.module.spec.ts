/**
 * T-RR-006. DI-wiring smoke test. `.compile()` alone does not open any real DB connection beyond
 * what `ServiceConfigRepository`'s own constructor does (opening a `pg.Pool`, which lazily
 * connects on first query — no query runs here), so this stays a fast, no-DB-round-trip test —
 * same precedent `EncryptionModule`'s own module spec (T-RR-005) already established.
 */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@/config/config.module';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import { ServiceConfigModule } from '@/modules/service-config/service-config.module';
import { ServiceConfigRepository } from '@/modules/service-config/service-config.repository';

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
