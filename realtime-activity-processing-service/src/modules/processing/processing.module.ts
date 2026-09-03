/**
 * T-RAP-030. Owns its own runtime Postgres connection (the least-privilege `rap_app` role,
 * `AGENT-PROTOCOL.md` R1) — same self-contained-connection precedent every prior module in this
 * service has followed (see `activity-log-claim.repository.ts`'s own header).
 *
 * Imports `ServiceConfigModule` (for `ServiceConfigResolverService`, T-RAP-013) so the worker/sweep
 * can resolve their own tunables (`processing.config.ts`).
 *
 * Binds `ACTIVITY_LOG_ROW_HANDLER` to `RuleEvaluationRowHandler` (T-RAP-031, this task's own real
 * implementation of `05-PROCESSING-PIPELINE.md` §3-§5) in place of the `NoopActivityLogRowHandler`
 * placeholder T-RAP-030 originally bound here — that task's own header named this task as the one
 * expected to replace this one provider binding, not add a second module. `RuleEvaluationRowHandler`
 * is itself the extension point T-RAP-032/033/034 (same owning agent, same directory file-scope
 * grant) continue building on (`rule-evaluation-row-handler.service.ts`'s own header) — see that
 * file, `invalidation.config.ts`/`campaign-config-cache.module.ts`'s own precedent for "a file not
 * literally named in one task's own list, edited by a later task under the same owning agent."
 *
 * Imports `CampaignConfigCacheModule` (T-RAP-010) for `CampaignConfigCacheService` — the read
 * surface `RuleEvaluationRowHandler` resolves cached `RuleRef`s through — and `ServiceConfigModule`
 * (T-RAP-013) for `ServiceConfigResolverService` (the worker/sweep's own tunables, plus this task's
 * own `advisory_lock_wait_timeout_ms`).
 *
 * Not wired into `AppModule` by this task — same convention every prior Wave 1/2 module has set
 * (nothing transport-facing/handler-providing exists yet to consume it).
 *
 * **T-RAP-034 update:** `RuleEvaluationRowHandler`'s own constructor grew a `CapEnforcementService`
 * dependency back in T-RAP-033, and this module's `providers` array was never updated to actually
 * supply one — a real NestJS DI compile (`Test.createTestingModule({ imports: [ProcessingModule]
 * }).compile()`, not just `tsc`) has been broken since that task, only surfaced now by
 * `dispatch.module.ts`'s own DI-wiring smoke test (`dispatch.module.spec.ts`), which imports this
 * module to reuse `PROCESSING_SEQUELIZE`. Fixed here rather than left for a future task: this file
 * is in this same owning agent's file scope (`modules/processing/**`), the gap blocks this task's
 * own explicit deliverable from actually compiling via real DI, and leaving a known-broken module
 * in place is worse than the small provider-list addition needed to close it. Adds
 * `CapEnforcementService` and its own three dependencies (`BudgetConsumptionRepository`,
 * `CustomerLimitConsumptionRepository`, `BudgetBreachCallbackClient` — all reusing
 * `PROCESSING_SEQUELIZE`/`loadCampaignConfigClientOptions()`, same factory-provider precedent
 * `CampaignConfigClient` itself already established) plus `RewardEntryRepository`/
 * `RewardEntryOutboxRepository` (T-RAP-034's own reward-creation repositories,
 * `RuleEvaluationRowHandler`'s two newest constructor parameters).
 *
 * **T-RAP-059 update:** imports `ObservabilityModule` (T-RAP-043) so `MetricsService`/
 * `StructuredLoggerFactory` resolve for `ActivityLogClaimWorker`, `RuleEvaluationRowHandler` and
 * (via `budget.module`-equivalent inline providers above) `CapEnforcementService` — none of those
 * three constructors gained an optional/defaulted parameter for these two collaborators, so a real
 * DI compile of this module was broken until this import was added, same class of gap this file's
 * own header already documents once before for `CapEnforcementService` itself (T-RAP-034 update,
 * above).
 */
import { Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize-typescript';
import type { Config } from '@/config/config.schema';
import { CampaignConfigCacheModule } from '@/modules/campaign-cache/campaign-config-cache.module';
import { loadCampaignConfigClientOptions } from '@/modules/campaign-cache/campaign-config.client';
import { ServiceConfigModule } from '@/modules/service-config/service-config.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { CapEnforcementService } from '@/modules/budget/cap-enforcement.service';
import { BudgetConsumptionRepository } from '@/modules/budget/budget-consumption.repository';
import { CustomerLimitConsumptionRepository } from '@/modules/budget/customer-limit-consumption.repository';
import { BudgetBreachCallbackClient } from '@/modules/budget/budget-breach-callback.client';
import { RewardEntryRepository } from '@/modules/reward-entry/reward-entry.repository';
import { RewardEntryOutboxRepository } from '@/modules/reward-entry/reward-entry-outbox.repository';
import { ActivityLogClaimRepository, PROCESSING_SEQUELIZE } from './activity-log-claim.repository';
import { ActivityLogClaimWorker } from './activity-log-claim.worker';
import { ACTIVITY_LOG_ROW_HANDLER } from './activity-log-row.handler';
import { RuleEvaluationRowHandler } from './rule-evaluation-row-handler.service';
import { RuleEvaluatorService } from './rule-evaluator.service';
import { StaleProcessingSweepService } from './stale-processing-sweep.service';
import { TrackerCompletionEvaluatorService } from './tracker-completion-evaluator.service';
import { TrackerComponentProgressRepository } from './tracker-component-progress.repository';
import { TrackerStatusRepository } from './tracker-status.repository';

/**
 * `ProcessingModule`'s own Sequelize connection pool has no built-in Nest lifecycle hook by
 * default — same leaked-connection fix every prior module's own `SequelizeShutdownHook` already
 * documents (see e.g. `activity-mapping.module.ts`'s own header).
 */
@Injectable()
class SequelizeShutdownHook implements OnModuleDestroy {
  constructor(@Inject(PROCESSING_SEQUELIZE) private readonly sequelize: Sequelize) {}

  async onModuleDestroy(): Promise<void> {
    await this.sequelize.close();
  }
}

@Module({
  imports: [CampaignConfigCacheModule, ServiceConfigModule, ObservabilityModule],
  providers: [
    {
      provide: PROCESSING_SEQUELIZE,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Config, true>): Sequelize =>
        new Sequelize({
          dialect: 'postgres',
          host: configService.get('DB_HOST', { infer: true }),
          port: configService.get('DB_PORT', { infer: true }),
          database: configService.get('DB_NAME', { infer: true }),
          username: configService.get('DB_APP_USERNAME', { infer: true }),
          password: configService.get('DB_APP_PASSWORD', { infer: true }),
          logging: false,
          dialectOptions: configService.get('DB_SSL', { infer: true })
            ? { ssl: { require: true, rejectUnauthorized: false } }
            : {},
        }),
    },
    ActivityLogClaimRepository,
    RuleEvaluatorService,
    TrackerComponentProgressRepository,
    TrackerCompletionEvaluatorService,
    TrackerStatusRepository,
    BudgetConsumptionRepository,
    CustomerLimitConsumptionRepository,
    {
      // Not Nest's implicit constructor-injection: `BudgetBreachCallbackClient`'s own constructor
      // parameter is a plain options interface, not a class — same reasoning
      // `campaign-config-cache.module.ts`'s own `CampaignConfigClient` factory provider documents.
      provide: BudgetBreachCallbackClient,
      useFactory: (): BudgetBreachCallbackClient =>
        new BudgetBreachCallbackClient(loadCampaignConfigClientOptions()),
    },
    CapEnforcementService,
    RewardEntryRepository,
    RewardEntryOutboxRepository,
    { provide: ACTIVITY_LOG_ROW_HANDLER, useClass: RuleEvaluationRowHandler },
    ActivityLogClaimWorker,
    StaleProcessingSweepService,
    SequelizeShutdownHook,
  ],
  exports: [
    PROCESSING_SEQUELIZE,
    ActivityLogClaimRepository,
    RuleEvaluatorService,
    TrackerComponentProgressRepository,
    TrackerCompletionEvaluatorService,
    TrackerStatusRepository,
    CapEnforcementService,
    RewardEntryRepository,
    RewardEntryOutboxRepository,
    ActivityLogClaimWorker,
    StaleProcessingSweepService,
  ],
})
export class ProcessingModule {}
