/**
 * T-RR-025. Shared harness for `../concurrency-load-safety.e2e-spec.ts` — an instrumented
 * `RewardSystemConnector` test double plus a small worker-pool runner that claims real rows from
 * the real, shared `reward_redemption_entry` table (`RewardRedemptionEntryClaimRepository`,
 * T-RR-020) and drives each one through the real `RedemptionProcessingOrchestrator`/
 * `RedemptionStateMachineService` (T-RR-024/T-RR-021) — every layer `01-DATABASE.md` §12's
 * three-layer model actually depends on, except the two cached campaign/connector-config lookups
 * (`RewardSystemResolutionService`/`ExternalRewardSystemConfigResolver`), which this harness
 * replaces with fixed, typed stand-ins (the same "construct directly, no `TestingModule`, cast
 * through `ConstructorParameters`" idiom `redemption-processing-orchestrator.service.spec.ts`
 * already established for its own unit tests) — resolving those two caches is Wave 1's own
 * portal-feed-caching concern, not this task's own scope (this task's own Scope section: proving
 * the claim/process/exactly-once machinery under real contention, not campaign-config resolution).
 *
 * **Shares `CROSS_FILE_CLAIM_TEST_MUTEX_KEY` with `reward-redemption-entry-claim.repository.spec.ts`
 * / `claim-worker.service.spec.ts` (T-RR-020, T-RR-052).** Those two files' own headers explain why
 * a session-level Postgres advisory lock — not tenant-scoping alone — is needed to safely run more
 * than one real, actively-claiming test file against this shared, un-tenant-scoped table at the
 * same time. This suite claims real `received`/`retrying` rows too (that is the entire point), so
 * it joins the same mutex rather than re-discovering that exact race the hard way a third time.
 * Every worker loop here also tenant-scopes and gives back any claimed row it doesn't recognize
 * (T-RR-048's own pattern), for the same reason those two files do: an arbitrary *other*,
 * non-claiming real-DB spec file (an ingestion test, a migration test, ...) is not party to the
 * mutex and can still insert its own `received` row into this shared table at any moment.
 */
import { randomUUID } from 'node:crypto';
import { Sequelize, QueryTypes } from 'sequelize';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import type { ExternalRewardSystemConfigRow } from '@/database/models/external-reward-system-config.model';
import type {
  RedemptionResult,
  RewardSystemConnector,
} from '@/modules/connectors/reward-system-connector.interface';
import { RewardRedemptionEntryClaimRepository } from '@/modules/processing/reward-redemption-entry-claim.repository';
import { RedemptionProcessingOrchestrator } from '@/modules/processing/redemption-processing-orchestrator.service';
import type { ResolvedRewardSystem } from '@/modules/processing/reward-system-resolution.service';
import { RetryClassificationService } from '@/modules/reward-system-config/retry-classification.service';
import { RedemptionStateMachineService } from '@/modules/redemption/redemption-state-machine.service';
import type { RedemptionCompletionSideEffectsPort } from '@/modules/redemption/redemption-completion-side-effects.port';
import { MetricsRegistry } from '@/observability/metrics.registry';

/** Must match the identical constant in `reward-redemption-entry-claim.repository.spec.ts` /
 * `claim-worker.service.spec.ts` exactly (T-RR-020/T-RR-052) — see this file's own header. */
export const CROSS_FILE_CLAIM_TEST_MUTEX_KEY = 52_020_021;

/** Same `ConfigService` stand-in idiom every real-DB spec file in this service already uses,
 * reading the real `.env.development` values `test/database/env.setup.ts` loads. */
export function realDbConfigService(overrides: Partial<Config> = {}): ConfigService<Config, true> {
  const values: Partial<Config> = {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT),
    DB_NAME: process.env.DB_NAME,
    DB_SSL: process.env.DB_SSL === 'true',
    DB_APP_USERNAME: process.env.DB_APP_USERNAME,
    DB_APP_PASSWORD: process.env.DB_APP_PASSWORD,
    NODE_ENV: 'development',
    ...overrides,
  };
  return {
    get: ((key: keyof Config) => values[key]) as ConfigService<Config, true>['get'],
  } as ConfigService<Config, true>;
}

function buildPool(max: number): Pool {
  return new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_APP_USERNAME,
    password: process.env.DB_APP_PASSWORD,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    max,
  });
}

/**
 * A real, dedicated connection pool sized for genuine N-way concurrent claim traffic — `pg`'s own
 * default `max` (10) would otherwise silently serialize a wider worker pool behind pool-checkout
 * queuing, which would be a test-harness artifact, not the property this suite exists to exercise
 * (this task's own implementation note 2: "genuinely concurrent client connections ... not
 * serialized by a shared client").
 */
export function buildClaimRepository(poolMax = 20): RewardRedemptionEntryClaimRepository {
  return new RewardRedemptionEntryClaimRepository(realDbConfigService(), buildPool(poolMax));
}

/** Never actually invoked by this suite — `RedemptionProcessingOrchestrator.processClaimedEntry`
 * only ever calls `markDispatchedExternal`/`markCompletedDirect`/`markRetrying`/`markFailed`
 * (`redemption-processing-orchestrator.service.ts`'s own header); `completeDispatched` (the one
 * `RedemptionStateMachineService` method that calls this port) is a separate, later step
 * (`05-PROCESSING-PIPELINE.md` §6 steps 3-5) this task's own Scope section does not cover. Supplied
 * only because `RedemptionStateMachineService`'s constructor requires one. */
export class NoopCompletionSideEffects implements RedemptionCompletionSideEffectsPort {
  async recordCompletionSideEffects(): Promise<void> {
    /* intentionally empty — see this class's own doc comment. */
  }
}

export function buildStateMachine(poolMax = 20): RedemptionStateMachineService {
  return new RedemptionStateMachineService(
    realDbConfigService(),
    new NoopCompletionSideEffects(),
    buildPool(poolMax),
  );
}

export const LOAD_TEST_SYSTEM_CODE = 'LOAD_TEST_SYSTEM';

function buildResolvedReward(): ResolvedRewardSystem {
  return {
    systemCode: LOAD_TEST_SYSTEM_CODE,
    rewardType: 'CASHBACK',
    deliveryMode: 'API',
    unitType: 'cashback',
    unitCode: 'LOAD_TEST_UNIT',
    level: 'campaign',
    refId: 0,
    versionNo: 1,
    status: 'active',
  };
}

export function buildLoadTestConnectorConfig(
  overrides: Partial<ExternalRewardSystemConfigRow> = {},
): ExternalRewardSystemConfigRow {
  return {
    id: 1,
    system_code: LOAD_TEST_SYSTEM_CODE,
    tenant_id: null,
    connector_type: 'LOAD_TEST_CONNECTOR',
    endpoint_url: 'https://load-test-connector.internal/redeem',
    auth_secret_ref: 'secret-ref-placeholder',
    retryable_error_codes: ['LOAD_TEST_RETRYABLE'],
    max_retry_attempts: 5,
    retry_backoff_base_ms: 10,
    retry_backoff_max_ms: 50,
    status: 'active',
    created_at: new Date(),
    updated_at: new Date(),
    tenant_key: -1,
    ...overrides,
  };
}

export function successOutcome(referenceSuffix = randomUUID()): RedemptionResult {
  return {
    outcome: 'SUCCESS',
    externalReferenceId: `LOAD-TEST-${referenceSuffix}`,
    responseSummary: { status: 'SUCCESS' },
  };
}

/**
 * `RewardSystemConnector` test double — the one thing this suite's own assertions actually pivot
 * on (this task's own implementation note 6): every `redeem()` invocation is recorded per entry
 * `id`, so a second call for an `id` already seen is directly observable, never inferred from
 * timing. Fully typed (a `Map<string, number>` plus a typed log array) — no loose accumulator
 * object (implementation note 8, R2).
 */
export class InstrumentedConnector implements RewardSystemConnector {
  private readonly callCountByEntryId = new Map<string, number>();
  readonly callLog: Array<{ entryId: string; callNumber: number; atMs: number }> = [];

  /** @param resolveOutcome Defaults to an immediate `SUCCESS` for every call — a scenario that
   *   needs a different outcome (a scripted delay, a failure) passes its own function. Receives
   *   the 1-based call number for this specific entry id, so a scenario can script behavior only
   *   for a first attempt without needing its own separate counter. */
  constructor(
    private readonly resolveOutcome: (
      entry: RewardRedemptionEntryRow,
      callNumber: number,
    ) => Promise<RedemptionResult> | RedemptionResult = () => successOutcome(),
  ) {}

  async redeem(entry: RewardRedemptionEntryRow): Promise<RedemptionResult> {
    const callNumber = (this.callCountByEntryId.get(entry.id) ?? 0) + 1;
    this.callCountByEntryId.set(entry.id, callNumber);
    this.callLog.push({ entryId: entry.id, callNumber, atMs: Date.now() });
    return this.resolveOutcome(entry, callNumber);
  }

  callCountFor(entryId: string): number {
    return this.callCountByEntryId.get(entryId) ?? 0;
  }

  /** The one property every scenario in this suite must never violate (implementation note 6) —
   * a non-empty result here is an automatic test failure wherever it's asserted, never something
   * to tolerate as "rare". */
  idsCalledMoreThanOnce(): string[] {
    return Array.from(this.callCountByEntryId.entries())
      .filter(([, count]) => count > 1)
      .map(([id]) => id);
  }
}

/** Builds a real `RedemptionProcessingOrchestrator` wired to `connector` via a fixed
 * resolution/connector-config pair (this file's own header) plus the real
 * `RetryClassificationService` and the real, caller-supplied `stateMachine`. Cast through
 * `ConstructorParameters<...>` rather than typed directly against
 * `RewardSystemResolutionService`/`ExternalRewardSystemConfigResolver`/`ConnectorRegistry` — same
 * "plain object satisfies the shape actually called" idiom
 * `redemption-processing-orchestrator.service.spec.ts` already established, since those three
 * classes carry real constructor dependencies (a live `CampaignConfigCache` gRPC client, a real
 * DB-backed resolver, a `Map`-backed registry) this suite has no reason to stand up for a fixed,
 * always-the-same-connector test double.
 *
 * **T-RR-065.** Every row `insertEntry` (this suite's own fixture) inserts leaves `tenant_code`/
 * `country_code` `NULL` (matching a real freshly-ingested row) — `RedemptionProcessingOrchestrator
 * .processClaimedEntry` now runs claim-time enrichment as its own first step, so this harness needs
 * a `TenantSchemaEnrichmentService` stand-in too, not just the two fixed campaign/connector-config
 * lookups. A fixed, always-the-same-tenant/country stamp is enough here for the identical reason
 * `buildResolvedReward()`/`connectorConfig` already are: this suite's own scope is the
 * claim/process/exactly-once machinery under real contention, not tenant/schema resolution. */
export function buildOrchestrator(
  connector: RewardSystemConnector,
  stateMachine: RedemptionStateMachineService,
  connectorConfig: ExternalRewardSystemConfigRow = buildLoadTestConnectorConfig(),
  metrics: MetricsRegistry = new MetricsRegistry(),
): RedemptionProcessingOrchestrator {
  const resolutionService = { resolve: async () => buildResolvedReward() };
  const configResolver = { resolve: async () => connectorConfig };
  const connectorRegistry = { resolve: () => connector };
  const retryClassification = new RetryClassificationService();
  const tenantSchemaEnrichment = {
    enrich: async (entry: RewardRedemptionEntryRow) =>
      entry.tenant_code !== null && entry.country_code !== null
        ? entry
        : { ...entry, tenant_code: 'LOAD_TEST_TENANT', country_code: 'US' },
  };

  return new RedemptionProcessingOrchestrator(
    resolutionService as unknown as ConstructorParameters<
      typeof RedemptionProcessingOrchestrator
    >[0],
    configResolver as unknown as ConstructorParameters<typeof RedemptionProcessingOrchestrator>[1],
    retryClassification,
    connectorRegistry as unknown as ConstructorParameters<
      typeof RedemptionProcessingOrchestrator
    >[3],
    stateMachine,
    metrics,
    tenantSchemaEnrichment as unknown as ConstructorParameters<
      typeof RedemptionProcessingOrchestrator
    >[6],
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Gives back a claimed row this pool doesn't own (a different test file's, or a different
 * tenant's, fixture) — the same `giveBackForeignRow` idiom
 * `reward-redemption-entry-claim.repository.spec.ts`/`claim-worker.service.spec.ts` already
 * established (T-RR-048): bumps `created_at` too, not just `status`, so the released row moves to
 * the back of the claim query's own `ORDER BY created_at` instead of being immediately
 * reclaimed-and-released in a livelock. */
export async function giveBackForeignRow(migrationDb: Sequelize, id: string): Promise<void> {
  await migrationDb.query(
    `UPDATE reward_redemption.reward_redemption_entry
       SET status = 'received', updated_at = now(), created_at = now()
     WHERE id = :id`,
    { type: QueryTypes.RAW, replacements: { id } },
  );
}

export interface RunWorkerPoolOptions {
  workerCount: number;
  /** Only rows carrying this `tenant_id` are actually processed — everything else claimed along
   * the way is a foreign row and is given back immediately (this file's own header). */
  tenantId: number;
  claimRepository: RewardRedemptionEntryClaimRepository;
  migrationDb: Sequelize;
  orchestrator: RedemptionProcessingOrchestrator;
  /** Checked before every claim attempt and after every empty poll — every worker loop exits once
   * this returns `true`. Deliberately synchronous: every caller in this suite tracks progress via
   * a plain in-memory counter incremented from `onProcessed`, so there is nothing to `await`. */
  isDone: () => boolean;
  onProcessed?: (row: RewardRedemptionEntryRow) => void;
  /** A hard wall-clock ceiling so a real defect (or an environment problem) can never hang the
   * suite forever — never a substitute for `isDone` under normal operation. */
  deadlineMs?: number;
  /** How long an individual worker sleeps after an empty poll before trying again. */
  idleSleepMs?: number;
}

export interface WorkerPoolOutcome {
  /** Every unexpected error any worker loop hit, tagged by worker id — an empty array is the only
   * passing outcome (this task's own Scope: "absence of any constraint violation or unhandled
   * error across the run"). A failed claim attempt or a failed `processClaimedEntry` call is
   * recorded here rather than thrown, so one worker's failure never aborts the other workers'
   * loops mid-run (mirroring `ClaimWorkerService`'s own real production behavior — a bad poll
   * logs and keeps going, it does not crash the process). */
  errors: string[];
}

/**
 * Runs `workerCount` concurrent claim+process loops against the real shared table
 * (`05-PROCESSING-PIPELINE.md` §3) until `isDone()` returns `true` or `deadlineMs` elapses. Each
 * loop: claim → if the row belongs to `tenantId`, drive it through `orchestrator
 * .processClaimedEntry` and report it via `onProcessed`; if the row belongs to any other tenant,
 * give it back immediately (T-RR-048) rather than process or strand it. This is the harness's own
 * "claim-worker+orchestrator loop" the task file's own Scope section asks for, reusable across
 * every scenario in the suite.
 */
export async function runWorkerPool(options: RunWorkerPoolOptions): Promise<WorkerPoolOutcome> {
  const errors: string[] = [];
  const deadline = Date.now() + (options.deadlineMs ?? 60_000);
  const idleSleepMs = options.idleSleepMs ?? 15;

  async function loop(workerId: number): Promise<void> {
    while (Date.now() < deadline) {
      if (options.isDone()) {
        return;
      }
      let claimed: RewardRedemptionEntryRow | null;
      try {
        claimed = await options.claimRepository.claimNext();
      } catch (error) {
        errors.push(
          `worker ${workerId} claimNext failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      if (!claimed) {
        await sleep(idleSleepMs);
        continue;
      }
      if (claimed.tenant_id !== options.tenantId) {
        await giveBackForeignRow(options.migrationDb, claimed.id);
        continue;
      }
      try {
        const result = await options.orchestrator.processClaimedEntry(claimed);
        options.onProcessed?.(result);
      } catch (error) {
        errors.push(
          `worker ${workerId} processing ${claimed.id} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: options.workerCount }, (_, workerId) => loop(workerId)));
  return { errors };
}
