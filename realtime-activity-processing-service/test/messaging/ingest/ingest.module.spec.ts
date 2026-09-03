/**
 * T-RAP-023. DI-wiring smoke test — same shape as `activity-mapping.module.spec.ts`'s own
 * precedent (T-RAP-021): `.compile()` alone never calls `OnModuleInit`/opens a real broker
 * connection (`ActivityIngestConsumer.onModuleInit` is a deliberate no-op, see its own header), it
 * only proves every provider in this module's DI graph (plus its imported `ActivityMappingModule`)
 * resolves to the right class.
 *
 * `FIELD_ENCRYPTION_AES_KEY`/`FIELD_ENCRYPTION_HMAC_KEY` are set for the duration of this suite —
 * `EncryptionModule`'s own `EncryptionService` factory (imported transitively via
 * `ActivityMappingModule`) throws at construction time without them, same precedent
 * `activity-mapping.module.spec.ts` already established.
 */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@/config/config.module';
import { IngestModule } from '@/messaging/ingest/ingest.module';
import {
  ActivityIngestConsumer,
  ActivityIngestDlqPublisher,
} from '@/messaging/ingest/activity-ingest.consumer';

const AES_KEY_B64 = Buffer.alloc(32, 1).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 2).toString('base64');

describe('IngestModule', () => {
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
      imports: [ConfigModule, IngestModule],
    }).compile();

    expect(moduleRef.get(ActivityIngestDlqPublisher)).toBeInstanceOf(ActivityIngestDlqPublisher);
    expect(moduleRef.get(ActivityIngestConsumer)).toBeInstanceOf(ActivityIngestConsumer);

    await moduleRef.close();
  });
});
