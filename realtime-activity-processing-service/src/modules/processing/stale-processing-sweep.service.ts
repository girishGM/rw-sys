/**
 * T-RAP-030. Implementation note 3: a row stuck in `processing` past a configurable timeout (a
 * worker crash mid-transaction — between `ActivityLogClaimWorker`'s own claim and whatever
 * transaction the handler opens) is reset back to `pending`, re-claimable by the next `SKIP
 * LOCKED` pass. Same `setInterval` + testable `runOnce()` shape as `ReconciliationPollerService`
 * (T-RAP-011) — a periodic safety-net sweep, not a claim-loop lane, so it does not share
 * `ActivityLogClaimWorker`'s own multi-lane scheduling.
 */
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import { ActivityLogClaimRepository } from './activity-log-claim.repository';
import {
  type ConfigResolver,
  DEFAULT_STALE_SWEEP_INTERVAL_MS,
  DEFAULT_STALE_TIMEOUT_SECONDS,
  PROCESSING_SERVICE_CONFIG_KEYS,
  resolvePositiveIntConfig,
  STALE_SWEEP_AUTOSTART,
  STALE_SWEEP_INTERVAL_MS,
} from './processing.config';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class StaleProcessingSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaleProcessingSweepService.name);
  private timer: NodeJS.Timeout | null = null;
  /** Guards against a slow sweep overlapping the next `setInterval` tick — same discipline
   * `ReconciliationPollerService.cycleInFlight` already established. */
  private cycleInFlight: Promise<number> | null = null;

  constructor(
    private readonly repository: ActivityLogClaimRepository,
    @Inject(ServiceConfigResolverService) private readonly configResolver: ConfigResolver,
    @Optional()
    @Inject(STALE_SWEEP_INTERVAL_MS)
    private readonly sweepIntervalMs: number = DEFAULT_STALE_SWEEP_INTERVAL_MS,
    @Optional()
    @Inject(STALE_SWEEP_AUTOSTART)
    private readonly autostart: boolean = true,
  ) {}

  onModuleInit(): void {
    if (this.autostart) {
      this.start();
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) => {
        this.logger.error(
          `Stale-processing sweep cycle threw unexpectedly: ${describeError(error)}`,
        );
      });
    }, this.sweepIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One sweep — exposed so tests drive it deterministically instead of racing `setInterval`, same
   * discipline as `ReconciliationPollerService.runOnce()`. Returns the number of rows reclaimed
   * (TC-2's own assertion surface).
   */
  async runOnce(): Promise<number> {
    if (this.cycleInFlight) {
      return this.cycleInFlight;
    }
    this.cycleInFlight = this.doRunOnce().finally(() => {
      this.cycleInFlight = null;
    });
    return this.cycleInFlight;
  }

  private async doRunOnce(): Promise<number> {
    const timeoutSeconds = resolvePositiveIntConfig(
      this.configResolver,
      PROCESSING_SERVICE_CONFIG_KEYS.STALE_TIMEOUT_SECONDS,
      {},
      DEFAULT_STALE_TIMEOUT_SECONDS,
      this.logger,
    );
    const reclaimed = await this.repository.sweepStaleProcessingRows(timeoutSeconds);
    if (reclaimed > 0) {
      this.logger.warn(
        `Stale-processing sweep reclaimed ${reclaimed} row(s) stuck in 'processing' past ` +
          `${timeoutSeconds}s back to 'pending'.`,
      );
    }
    return reclaimed;
  }
}
