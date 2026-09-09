import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { RewardRedemptionEntryClaimRepository } from './reward-redemption-entry-claim.repository';
import { RedemptionProcessingOrchestrator } from './redemption-processing-orchestrator.service';

/**
 * The claim worker's own operational knobs. Deliberately a small, named port/interface — not a
 * bare `{ pollIntervalMs: number }` object shape inlined at every call site — so the concrete
 * provider behind `CLAIM_WORKER_RUNTIME_CONFIG` (`claim-worker.module.ts`) can be swapped for a
 * `service_config`-backed one later without touching this file (R2 — no `any`, no unchecked cast
 * needed at either end of the seam).
 *
 * `05-PROCESSING-PIPELINE.md` §3's own implementation note 4 says this should be resolved through
 * T-RR-006's `ServiceConfigResolverService` (cache-wrapped by T-RR-007) — neither exists yet as of
 * this task (T-RR-020 depends only on T-RR-002, which is done; T-RR-006/007 are not in that
 * `Depends on` list and remain `pending`/not built). See `claim-worker.module.ts`'s own header and
 * `reward-redemption-service-plan/AUTONOMOUS-DECISIONS.md` for the interim decision this seam
 * exists to make trivially reversible once that module lands.
 */
export interface ClaimWorkerRuntimeConfig {
  /** How long to wait after an empty poll before trying again. */
  pollIntervalMs: number;
  /** `false` disables the poll loop entirely (e.g. for a deploy that runs no claim workers). */
  enabled: boolean;
}

export const CLAIM_WORKER_RUNTIME_CONFIG = Symbol('CLAIM_WORKER_RUNTIME_CONFIG');

/**
 * The polling loop itself. Runs inside this service's primary HTTP process (unlike the gRPC/Kafka
 * transports, the claim worker is not itself a separate listening transport — T-RR-001's
 * "standalone entry points" convention doesn't apply here, this task's own Scope section).
 *
 * Deliberately a single sequential loop per instance: `05-PROCESSING-PIPELINE.md` §8 / this task's
 * implementation note 6 only requires that this service not add in-process coordination that
 * would artificially serialize claims *beyond* what `FOR UPDATE SKIP LOCKED` already provides
 * across instances — it does not require any one instance to run multiple concurrent loops.
 * `reward-redemption-entry-claim.repository.spec.ts` (TC-5) proves the underlying claim SQL itself
 * is safe under real concurrent callers, independently of how many loops any one instance chooses
 * to run.
 *
 * **T-RR-058 (defect fix).** Before this task, a successful claim was stored in a local variable
 * and never handed to anything — `RedemptionProcessingOrchestrator.processClaimedEntry()` was
 * never called anywhere in this file, so a claimed row flipped to `processing` and then sat there
 * forever (the defect's own reproduction, `tasks/T-RR-058-*.md`). This constructor now takes the
 * orchestrator too, and a successful claim is driven straight into it before the loop continues.
 * `05-PROCESSING-PIPELINE.md` §1 lists "claim" as the one step *this* task (T-RR-020) owns and
 * everything else (§4-§7) as the orchestrator's own job (T-RR-024) — this call is exactly that
 * hand-off, not a duplication of orchestrator logic here.
 */
@Injectable()
export class ClaimWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ClaimWorkerService.name);
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  /** Resolved by `onModuleDestroy` so an in-flight `sleep()` between polls returns immediately
   * instead of blocking shutdown for up to a full `pollIntervalMs` (see `sleep()`'s own note). */
  private stopSignal: (() => void) | null = null;

  constructor(
    private readonly repository: RewardRedemptionEntryClaimRepository,
    @Inject(CLAIM_WORKER_RUNTIME_CONFIG) private readonly runtimeConfig: ClaimWorkerRuntimeConfig,
    private readonly orchestrator: RedemptionProcessingOrchestrator,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.runtimeConfig.enabled) {
      this.logger.log('Claim worker disabled (claimWorker.enabled=false) — poll loop not started.');
      return;
    }
    this.stopped = false;
    this.loopPromise = this.pollLoop();
  }

  /** Signals the loop to stop after its current iteration, and waits for it to actually exit.
   * Also wakes up an in-flight `sleep()` immediately (see `stopSignal`) — otherwise a shutdown
   * requested right after an empty poll would have to wait out the rest of `pollIntervalMs`
   * before this method could resolve, which is exactly the kind of slow, unpredictable shutdown a
   * deploy/restart cannot afford. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.stopSignal?.();
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      let claimed: Awaited<ReturnType<RewardRedemptionEntryClaimRepository['claimNext']>> = null;
      try {
        claimed = await this.repository.claimNext();
      } catch (error) {
        // A claim attempt failing is an infrastructure hiccup (e.g. a transient DB blip), not a
        // reason to crash the whole worker — log it and keep polling (implementation note 5's
        // "normal, expected outcome" framing extends to "don't take the loop down over one bad
        // poll" too).
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Claim worker poll failed: ${message}`);
      }

      if (this.stopped) {
        break;
      }

      if (claimed) {
        // T-RR-058: hand the claimed row off to the orchestrator (§4-§7 of
        // `05-PROCESSING-PIPELINE.md`) — this is the one call the pre-fix version of this file
        // never made. A throw here is treated the same way a failed `claimNext()` is (implementation
        // note 5's "normal, expected outcome" framing): logged, never crashes the loop. The row
        // itself is left exactly as `processClaimedEntry` left it — every state transition it can
        // reach (`dispatched_external`/`completed`/`retrying`/`failed`) is written by the state
        // machine's own committed transaction before this call can return, so a *rejected* promise
        // here means the call failed before reaching (or while performing) one of those writes, not
        // that a real transition was silently lost.
        try {
          await this.orchestrator.processClaimedEntry(claimed);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Claim worker failed to process claimed reward_redemption_entry ${claimed.id}: ${message}`,
          );
        }
      } else {
        // Implementation note 5: an empty poll is normal and must not be logged above debug.
        this.logger.debug('Claim worker poll found no eligible row.');
        await this.sleep(this.runtimeConfig.pollIntervalMs);
      }
      // A successful claim loops again immediately (no sleep) so the queue drains as fast as this
      // instance's own single loop can go, rather than waiting out the poll interval between every
      // row while work is actually available.
    }
  }

  /** Resolves after `ms`, or immediately if `onModuleDestroy` is called first — whichever comes
   * first. `unref()` also keeps a long-lived interval from holding the Node process open on its
   * own once nothing else is keeping it alive (e.g. under a test runner's own process teardown). */
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
