/**
 * T-RAP-034. DI-wiring smoke test for `ProcessingModule` itself — added alongside this task's own
 * fix (see `processing.module.ts`'s own "T-RAP-034 update" header) for the exact gap this test
 * exists to catch: `RuleEvaluationRowHandler`'s constructor dependencies growing (T-RAP-032/033/034)
 * without this module's own `providers` array being updated to actually supply them, which `tsc`
 * alone never catches (constructor injection is resolved at runtime, not compile time) but a real
 * `Test.createTestingModule(...).compile()` does. Same "`.compile()` never opens a real connection"
 * discipline as `dispatch.module.spec.ts`/`encryption.module.spec.ts`.
 *
 * **T-RAP-059 update:** `ProcessingModule` now imports `ObservabilityModule`, which imports
 * `EncryptionModule` for `LogRedactorService` — the same real-DI-compile requirement
 * `dispatch.module.spec.ts` already documents and satisfies for its own sibling module, applied
 * here with the identical env-var save/restore pattern (this file's own `.compile()` now
 * transitively resolves `LogRedactorService`'s `EncryptionService` sibling provider, which throws
 * without a seeded `FIELD_ENCRYPTION_AES_KEY`/`_HMAC_KEY`, `AGENT-PROTOCOL.md` R8).
 */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@/config/config.module';
import { CampaignConfigCacheModule } from '@/modules/campaign-cache/campaign-config-cache.module';
import { ServiceConfigModule } from '@/modules/service-config/service-config.module';
import { ProcessingModule } from '@/modules/processing/processing.module';
import { ACTIVITY_LOG_ROW_HANDLER } from '@/modules/processing/activity-log-row.handler';
import { RuleEvaluationRowHandler } from '@/modules/processing/rule-evaluation-row-handler.service';
import { ActivityLogClaimWorker } from '@/modules/processing/activity-log-claim.worker';
import { StaleProcessingSweepService } from '@/modules/processing/stale-processing-sweep.service';
import { CapEnforcementService } from '@/modules/budget/cap-enforcement.service';
import { RewardEntryRepository } from '@/modules/reward-entry/reward-entry.repository';
import { RewardEntryOutboxRepository } from '@/modules/reward-entry/reward-entry-outbox.repository';

const AES_KEY_B64 = Buffer.alloc(32, 41).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 42).toString('base64');

describe('ProcessingModule', () => {
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

  it('compiles via real DI and resolves ACTIVITY_LOG_ROW_HANDLER as a real RuleEvaluationRowHandler', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, CampaignConfigCacheModule, ServiceConfigModule, ProcessingModule],
    }).compile();

    expect(moduleRef.get(ACTIVITY_LOG_ROW_HANDLER)).toBeInstanceOf(RuleEvaluationRowHandler);
    expect(moduleRef.get(CapEnforcementService)).toBeInstanceOf(CapEnforcementService);
    expect(moduleRef.get(RewardEntryRepository)).toBeInstanceOf(RewardEntryRepository);
    expect(moduleRef.get(RewardEntryOutboxRepository)).toBeInstanceOf(RewardEntryOutboxRepository);
    expect(moduleRef.get(ActivityLogClaimWorker)).toBeInstanceOf(ActivityLogClaimWorker);
    expect(moduleRef.get(StaleProcessingSweepService)).toBeInstanceOf(StaleProcessingSweepService);

    await moduleRef.close();
  });
});
