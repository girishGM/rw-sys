/**
 * T-RAP-021. DI-wiring smoke test — same shape as `campaign-config-cache.module.spec.ts`'s own
 * precedent (T-RAP-010): `.compile()` alone never calls `OnModuleInit`/opens a real connection, it
 * only proves every provider in this module's DI graph (plus its imported
 * `CampaignConfigCacheModule`/`EncryptionModule`/`IdempotencyModule`) resolves to the right class.
 *
 * `FIELD_ENCRYPTION_AES_KEY`/`FIELD_ENCRYPTION_HMAC_KEY` are set for the duration of this suite —
 * `EncryptionModule`'s own `EncryptionService` factory (imported transitively via
 * `ActivityMappingModule`) throws at construction time without them, same precedent
 * `encryption.module.spec.ts` already established.
 */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@/config/config.module';
import { ActivityMappingModule } from '@/modules/activity-mapping/activity-mapping.module';
import { ActivityIngestionService } from '@/modules/activity-mapping/activity-ingestion.service';
import { ActivityMapper } from '@/modules/activity-mapping/activity-mapper';
import { ActivityLogsRepository } from '@/modules/activity-mapping/activity-logs.repository';

const AES_KEY_B64 = Buffer.alloc(32, 1).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 2).toString('base64');

describe('ActivityMappingModule', () => {
  const ENV_KEYS = ['FIELD_ENCRYPTION_AES_KEY', 'FIELD_ENCRYPTION_HMAC_KEY'] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
    process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('provides and exports every public class this module owns', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, ActivityMappingModule],
    }).compile();

    expect(moduleRef.get(ActivityLogsRepository)).toBeInstanceOf(ActivityLogsRepository);
    expect(moduleRef.get(ActivityMapper)).toBeInstanceOf(ActivityMapper);
    expect(moduleRef.get(ActivityIngestionService)).toBeInstanceOf(ActivityIngestionService);

    await moduleRef.close();
  });
});
