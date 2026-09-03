/**
 * T-RAP-034. DI-wiring smoke test — same shape as `encryption.module.spec.ts`/
 * `service-config.module.spec.ts`'s own precedent. `.compile()` alone does not invoke
 * `OnModuleInit` (that needs `moduleRef.init()`), so resolving every provider here never opens a
 * real Postgres connection, a real Kafka connection (`RewardKafkaProducerClient` connects lazily,
 * only on first `publish()`), or a real gRPC channel (`grpc-js` `Client` construction is also
 * lazy) — same "constructing is safe, connecting is what's deferred" discipline every prior module
 * in this project already relies on for its own DI-wiring smoke test.
 */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@/config/config.module';
import { DispatchModule } from '@/modules/dispatch/dispatch.module';
import { RewardEntryRepository } from '@/modules/reward-entry/reward-entry.repository';
import { RewardEntryOutboxRepository } from '@/modules/reward-entry/reward-entry-outbox.repository';
import { RewardDispatchRetryRepository } from '@/modules/dispatch/reward-dispatch-retry.repository';
import { OutboxPublisherService } from '@/modules/dispatch/outbox-publisher.service';
import { RewardDispatchRetryWorker } from '@/modules/dispatch/reward-dispatch-retry.worker';

const AES_KEY_B64 = Buffer.alloc(32, 21).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 22).toString('base64');

describe('DispatchModule', () => {
  const ENV_KEYS = [
    'FIELD_ENCRYPTION_AES_KEY',
    'FIELD_ENCRYPTION_HMAC_KEY',
    'OUTBOX_PUBLISHER_AUTOSTART',
    'RETRY_WORKER_AUTOSTART',
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
    process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;
    // Never let a real interval start even if some other file already set NODE_ENV oddly —
    // `.compile()` doesn't call `onModuleInit` anyway, but this keeps the factory's own resolved
    // value deterministic regardless.
    process.env.OUTBOX_PUBLISHER_AUTOSTART = 'false';
    process.env.RETRY_WORKER_AUTOSTART = 'false';
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
      imports: [ConfigModule, DispatchModule],
    }).compile();

    expect(moduleRef.get(RewardEntryRepository)).toBeInstanceOf(RewardEntryRepository);
    expect(moduleRef.get(RewardEntryOutboxRepository)).toBeInstanceOf(RewardEntryOutboxRepository);
    expect(moduleRef.get(RewardDispatchRetryRepository)).toBeInstanceOf(
      RewardDispatchRetryRepository,
    );
    expect(moduleRef.get(OutboxPublisherService)).toBeInstanceOf(OutboxPublisherService);
    expect(moduleRef.get(RewardDispatchRetryWorker)).toBeInstanceOf(RewardDispatchRetryWorker);

    await moduleRef.close();
  });
});
