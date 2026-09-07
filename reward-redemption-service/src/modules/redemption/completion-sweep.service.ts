import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import { MetricsRegistry } from '@/observability/metrics.registry';
import { RedemptionStateMachineService } from './redemption-state-machine.service';

/** `external_system_code` is selected alongside `id` (T-RR-057) — it was already populated by the
 * earlier `markDispatchedExternal` write for every row this query can possibly match (only rows
 * currently in `dispatched_external` are eligible), so it's the `system_code` label this sweep's
 * own `reward_redemptions_completed_total` increment needs, with no extra round trip. */
const STALE_DISPATCHED_EXTERNAL_SQL = `
  SELECT id, external_system_code FROM reward_redemption.reward_redemption_entry
  WHERE status = 'dispatched_external'
    AND updated_at < now() - ($1 * interval '1 second')
`;

/**
 * Purely an operational backoff for the *poll loop itself* when resolving
 * `completionSweep.intervalSeconds` fails (e.g. a missing `service_config` seed row) — never a
 * substitute for that resolved value, and never used for `completionSweep.graceSeconds` (the
 * business knob that actually decides which rows are "stale", always freshly resolved inside
 * `sweepOnce`, never defaulted). See this task's own completion report for the known gap this
 * guards against: no migration anywhere in this service currently seeds a `GLOBAL` `service_config`
 * row for either `completionSweep.*` key (filed as its own defect, out of this task's file scope —
 * `src/database/**` is `agent-rr-foundation`'s only).
 */
const INTERVAL_RESOLUTION_ERROR_RETRY_SECONDS = 30;

/**
 * T-RR-021. `05-PROCESSING-PIPELINE.md` §2's completion sweep: recovers a row stuck in
 * `dispatched_external` past a grace period **without ever re-invoking the connector** —
 * `external_reference_id` already being populated is exactly the signal that the external call
 * already succeeded and must not be repeated (§2's own explicit statement). Resumes *only* at the
 * outbox/notification step, via `RedemptionStateMachineService.completeDispatched` — the exact same
 * method the normal worker flow calls right after writing `dispatched_external`, so there is only
 * ever one code path that performs this transition (R10's spirit, applied within this service
 * rather than across transports).
 *
 * Needs no new table or index (§2's own note: "the set of rows genuinely stuck ... is expected to
 * be vanishingly small ... a full-table filter on that rare condition is cheap") — a plain
 * `WHERE status = 'dispatched_external' AND updated_at < now() - interval` scan, deliberately not
 * optimized with a new index.
 *
 * Sweep interval and grace period are `service_config` values
 * (`completionSweep.intervalSeconds`/`completionSweep.graceSeconds`,
 * `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §1), resolved via T-RR-006's
 * `ServiceConfigResolverService` on every iteration (so an operator change takes effect without a
 * restart) — never hardcoded, per requirement #8 and this task's own implementation note 5.
 *
 * Same manual poll-loop shape as `ClaimWorkerService` (T-RR-020) rather than a new scheduling
 * dependency — no `@nestjs/schedule` (or equivalent) is used anywhere else in this service, and
 * introducing one here for a single periodic job would be an unjustified new dependency.
 *
 * **T-RR-057.** This is the only real call site of `RedemptionStateMachineService.completeDispatched`
 * anywhere in the tree today (`RedemptionProcessingOrchestrator`'s own header documents why its
 * `SUCCESS` branch does not also call it) — so it is also where `reward_redemptions_completed_total`
 * must increment for every row this sweep resumes to `completed`, per `07-CONFIGURABILITY-AND-
 * OBSERVABILITY.md` §3. Incremented only after `completeDispatched` resolves without throwing, using
 * the row's own `external_system_code` (already selected alongside `id` by this file's own SQL,
 * never a fresh query) as the `system_code` label. Not de-duplicated against `completeDispatched`'s
 * own idempotent "already completed" short-circuit (§2's documented race between this sweep and a
 * concurrently-running sibling instance's own sweep) — that race is vanishingly rare by design (§2's
 * own framing) and, if it did fire, both completers legitimately observed a real `completed` outcome
 * for the row; see this task's own completion report for why a stricter exactly-once metric guarantee
 * was judged not worth the added complexity here.
 */
@Injectable()
export class CompletionSweepService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CompletionSweepService.name);
  private readonly pool: Pool;
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private stopSignal: (() => void) | null = null;

  constructor(
    private readonly stateMachine: RedemptionStateMachineService,
    private readonly serviceConfig: ServiceConfigResolverService,
    private readonly metrics: MetricsRegistry,
    config: ConfigService<Config, true>,
    @Optional() pool?: Pool,
  ) {
    this.pool =
      pool ??
      new Pool({
        host: config.get('DB_HOST', { infer: true }),
        port: config.get('DB_PORT', { infer: true }),
        database: config.get('DB_NAME', { infer: true }),
        user: config.get('DB_APP_USERNAME', { infer: true }),
        password: config.get('DB_APP_PASSWORD', { infer: true }),
        ssl: config.get('DB_SSL', { infer: true }) ? { rejectUnauthorized: false } : undefined,
      });
  }

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.loopPromise = this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.stopSignal?.();
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
    await this.pool.end();
  }

  /** One sweep pass — public so tests (and, at the architect's own discretion, an eventual admin
   * endpoint) can drive it deterministically instead of waiting out the poll loop. */
  async sweepOnce(): Promise<void> {
    const graceSeconds = await this.serviceConfig.resolve('completionSweep.graceSeconds', 'int');
    const stale = await this.pool.query<{ id: string; external_system_code: string | null }>(
      STALE_DISPATCHED_EXTERNAL_SQL,
      [graceSeconds],
    );

    if (!stale.rowCount) {
      this.logger.debug('Completion sweep: no stale dispatched_external rows found.');
      return;
    }

    for (const { id, external_system_code: externalSystemCode } of stale.rows) {
      try {
        // eslint-disable-next-line no-await-in-loop -- deliberately sequential: this is a rare
        // recovery path (§2's own "vanishingly small" framing), not a throughput-critical one: no
        // reason to add concurrency-control complexity for a batch that is expected to be tiny.
        await this.stateMachine.completeDispatched(id);
        // T-RR-057: only now that the resume actually resolved without throwing. `external_system_
        // code` should always be populated for a row that ever reached `dispatched_external`
        // (`markDispatchedExternal` writes it in the same transaction as the status flip) — the
        // null guard below is defensive, not an expected path, and is itself logged loudly rather
        // than silently skipped so a real data gap would surface.
        if (externalSystemCode) {
          this.metrics.incrementRewardRedemptionsCompleted(externalSystemCode);
        } else {
          this.logger.error(
            `Completion sweep resumed entry ${id} to 'completed' with no external_system_code ` +
              'recorded — reward_redemptions_completed_total not incremented for this entry.',
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Completion sweep failed to resume entry ${id}: ${message}`);
      }
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let intervalSeconds = INTERVAL_RESOLUTION_ERROR_RETRY_SECONDS;
      try {
        intervalSeconds = await this.serviceConfig.resolve(
          'completionSweep.intervalSeconds',
          'int',
        );
        await this.sweepOnce();
      } catch (error) {
        // An infrastructure hiccup (transient DB blip, or a missing service_config seed row) is
        // not a reason to crash the whole sweep loop — log it and keep polling, same discipline
        // `ClaimWorkerService` already established for its own poll failures.
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Completion sweep iteration failed: ${message}`);
      }

      if (this.stopped) {
        break;
      }
      await this.sleep(intervalSeconds * 1000);
    }
  }

  /** Resolves after `ms`, or immediately if `onModuleDestroy` is called first — identical idiom to
   * `ClaimWorkerService.sleep` (T-RR-020), reused here for the same shutdown-latency reason. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      this.stopSignal = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
