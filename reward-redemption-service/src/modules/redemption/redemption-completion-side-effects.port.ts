import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import { DispatchChannelResolverService } from '@/modules/dispatch/dispatch-channel-resolver.service';
import { RewardTrackingOutboxRepository } from '@/modules/dispatch/reward-tracking-outbox.repository';
import { NotificationService } from '@/modules/notification/notification.service';

/**
 * T-RR-021 scope note: the actual outbox-row (`reward_tracking_dispatch_outbox`,
 * `01-DATABASE.md` §7) and notification-log-row (`notification_log`, `01-DATABASE.md` §8)
 * construction — resolving `dispatch_channel_config` precedence, building the outbound payload,
 * checking the campaign's notification config — belongs to Wave 3's `agent-rr-integration` module
 * (`05-PROCESSING-PIPELINE.md` §6 steps 3-4; this task's own Scope section explicitly calls this
 * out as "Out"). `RedemptionStateMachineService`/`CompletionSweepService` only need *a* call site
 * that runs at the right point in the `dispatched_external -> completed` transition sequence — this
 * port is that seam. Once T-RR-034/T-RR-036 exist, swapping the `useClass`/`useValue` provider
 * bound to `REDEMPTION_COMPLETION_SIDE_EFFECTS_PORT` (`redemption-state-machine.module.ts`) for a
 * real implementation is the only change needed here; no other file in this task changes.
 *
 * **T-RR-061 update (2026-09-06).** T-RR-034/T-RR-036 now both exist and are wired into
 * `redemption-state-machine.module.ts` (`DispatchModule`/`NotificationModule`) — see
 * `RedemptionCompletionSideEffects` below, the real implementation that closes this file's own
 * long-standing TODO. `NotImplementedRedemptionCompletionSideEffects` stays in this file (still
 * exported) as a documented, explicit fallback a future composition root can bind to if it needs
 * this pipeline without pulling in the dispatch/notification stack — it is simply no longer the
 * *default* binding.
 */
export interface RedemptionCompletionSideEffectsPort {
  /**
   * Called once per `dispatched_external -> completed` transition, *before* the transition's own
   * status-flip transaction (`RedemptionStateMachineService.completeDispatched`) — mirroring
   * `05-PROCESSING-PIPELINE.md` §3's rule that a slow, out-of-process call must never run inside an
   * open Postgres transaction or while holding the advisory lock, applied here to this call instead
   * of the connector call.
   */
  recordCompletionSideEffects(entry: RewardRedemptionEntryRow): Promise<void>;
}

export const REDEMPTION_COMPLETION_SIDE_EFFECTS_PORT = Symbol(
  'REDEMPTION_COMPLETION_SIDE_EFFECTS_PORT',
);

/**
 * TODO(T-RR-034/T-RR-036): **no longer the default binding as of T-RR-061** — see this file's own
 * header. Kept only as an explicit, clearly-labelled fallback. Deliberately a no-op, not a throw:
 * a `dispatched_external` row must still be able to reach `completed` even when this stub is bound
 * (this is a redemption/delivery split, `ARCHITECTURE.md` §9 — a missing *delivery* leg must never
 * block the redemption's own terminal state). Logs a `warn` on every call so a deployment that
 * somehow still reaches this code path has a visible, greppable signal instead of a silent gap.
 */
@Injectable()
export class NotImplementedRedemptionCompletionSideEffects implements RedemptionCompletionSideEffectsPort {
  private readonly logger = new Logger(NotImplementedRedemptionCompletionSideEffects.name);

  async recordCompletionSideEffects(entry: RewardRedemptionEntryRow): Promise<void> {
    this.logger.warn(
      `TODO(T-RR-034/T-RR-036): no reward-tracking-dispatch-outbox/notification-log writer wired ` +
        `yet for reward_redemption_entry ${entry.id} — skipping 05-PROCESSING-PIPELINE.md §6 steps ` +
        '3-4 until Wave 3 lands.',
    );
  }
}

/**
 * T-RR-061. The real `RedemptionCompletionSideEffectsPort` implementation — closes the gap this
 * task was filed against: `reward_redemption_entry` rows now actually reach `dispatched_external`/
 * `completed` in the real running claim-worker process (T-RR-058), so the outbox/notification leg
 * this class drives is no longer dead code behind an unused stub.
 *
 * `05-PROCESSING-PIPELINE.md` §6 steps 3-4, in order:
 *  3. Resolve `dispatch_channel_config` precedence (`DispatchChannelResolverService`, T-RR-033) for
 *     this entry's `reward_code`/`tracker_code`/`campaign_code`/`tenant_id`, then write a
 *     `reward_tracking_dispatch_outbox` row (`RewardTrackingOutboxRepository.enqueue`, T-RR-034).
 *     Resolving first and failing loudly on a miss (`DispatchChannelResolutionError` — that
 *     service's own "fail loudly, never guess" contract) rather than writing an outbox row nothing
 *     could ever route: `006_create_dispatch_channel_config.ts` always seeds exactly one `GLOBAL`
 *     row, so in practice this only ever throws on a genuine environment misconfiguration, never on
 *     a normal redemption. `OutboxPublisherService` re-resolves independently at publish time
 *     (its own poll cycle, `outbox-publisher.service.ts`) to pick the actual channel — this call is
 *     a write-time validation gate, not a cache of that decision.
 *  4. Check whether customer notification is enabled for this campaign/reward
 *     (`NotificationService.notifyIfConfigured`, T-RR-036) — that method already never throws
 *     (logs and swallows its own failures internally), so it is always safe to call unconditionally
 *     after step 3 succeeds.
 *
 * **Failure semantics.** Unlike `notifyIfConfigured`, a genuine failure resolving
 * `dispatch_channel_config` or writing the outbox row is allowed to propagate out of
 * `recordCompletionSideEffects` here, deliberately: `RedemptionStateMachineService.completeDispatched`
 * (this port's only real caller) runs this call *before* its own status-flip transaction
 * (`redemption-completion-side-effects.port.ts`'s own interface doc), so a thrown error here simply
 * leaves the row in `dispatched_external` — never `failed` (§7's own "no edge into `failed` from
 * `dispatched_external`" rule is enforced by `RedemptionStateMachineService` itself, not by this
 * class) — for `CompletionSweepService`'s later sweep pass to retry once the underlying condition
 * (e.g. a missing `dispatch_channel_config` row) is fixed. This is strictly better than silently
 * dropping an outbox row this service would otherwise never be able to re-enqueue: the redemption
 * fact itself (already durably committed by `markDispatchedExternal`, §7) is never at risk either
 * way, only how soon the tracking-service dispatch/notification leg catches up.
 *
 * **Known, pre-existing race — flagged, not fixed, by this task (see the completion report).**
 * `completeDispatched`'s own docs already accept that the normal worker flow and
 * `CompletionSweepService` can legitimately race to resume the same row after a crash between this
 * call succeeding and the status-flip transaction committing. Before this task, that race was inert
 * (the stub was a no-op). Now that this class does real, non-idempotent work, that same crash
 * window means a resumed row could enqueue a *second* `reward_tracking_dispatch_outbox` row (and a
 * second `notification_log` row) for one `reward_entry_id` — `010_create_reward_tracking_dispatch_
 * outbox.ts` has no uniqueness constraint on `reward_entry_id` to prevent it. Fixing this needs
 * either a unique constraint + `ON CONFLICT DO NOTHING` in `RewardTrackingOutboxRepository.enqueue`
 * (a migration + a change to a file under `src/modules/dispatch/**`) or making steps 3-5 one atomic
 * transaction in `redemption-state-machine.service.ts` (`src/modules/redemption/**`, in this agent's
 * own directory grant, but outside *this task's* own "Files owned" list) — both outside this task's
 * scope as filed. Per `AGENT-PROTOCOL.md` §3 ("implement to spec, flag the flaw ... let the
 * architect decide"), this is flagged here and in the completion report, not silently redesigned.
 */
@Injectable()
export class RedemptionCompletionSideEffects
  implements RedemptionCompletionSideEffectsPort, OnModuleDestroy
{
  private readonly logger = new Logger(RedemptionCompletionSideEffects.name);
  private readonly pool: Pool;

  /** Own small `pg.Pool`, same convention every repository/service in this service already uses
   * (`RedemptionStateMachineService`, `RewardTrackingOutboxRepository`, ...) — needed because
   * `RewardTrackingOutboxRepository.enqueue` requires a caller-supplied `PoolClient` and this class
   * is that caller (this file's own header: no shared runtime DB pool module exists anywhere in
   * this service). `@Optional()` `pool` param exists solely so a test can substitute a real
   * (test-owned) or fake `Pool`. */
  constructor(
    private readonly dispatchResolver: DispatchChannelResolverService,
    private readonly outboxRepository: RewardTrackingOutboxRepository,
    private readonly notificationService: NotificationService,
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

  async recordCompletionSideEffects(entry: RewardRedemptionEntryRow): Promise<void> {
    await this.enqueueTrackingDispatch(entry);

    await this.notificationService.notifyIfConfigured(entry, {
      externalSystemCode: entry.external_system_code,
      externalReferenceId: entry.external_reference_id,
    });
  }

  /** §6 step 3. `enqueue()` takes a `pg.PoolClient`, never this class's own `Pool` directly — a
   * single `INSERT ... RETURNING *` needs no explicit `BEGIN`/`COMMIT` around it (Postgres commits
   * a lone statement atomically on its own), so this only borrows one connection from the pool for
   * the duration of the call. */
  private async enqueueTrackingDispatch(entry: RewardRedemptionEntryRow): Promise<void> {
    await this.dispatchResolver.resolve({
      rewardCode: entry.reward_code,
      trackerCode: entry.tracker_code,
      campaignCode: entry.campaign_code,
      tenantId: entry.tenant_id,
    });

    const client = await this.pool.connect();
    try {
      await this.outboxRepository.enqueue(client, entry);
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
