/**
 * T-047 — `ConfigChangeEvent`, and the one rule that makes it safe (09-INTEGRATION.md §9).
 *
 * ```
 * Maker edits campaign ──► pending_approval ──► NO EVENT (not yet real)
 * Checker approves ─────► active ───────────► UPDATED
 * Super Admin blasts v3 ─► new campaigns only ─► NO EVENT for existing campaigns
 * Tenant admin pauses ──► paused ────────────► PAUSED
 * Runtime reports a breach ─► paused (§7a) ──► PAUSED   (same event as a manual pause)
 * ```
 *
 * > *"The third line is the one to get right. **A blast must not emit change events for running
 * > campaigns**, because those campaigns are pinned to their existing version and their
 * > configuration has not changed. Emitting there would cause the runtime to refetch and — if the
 * > pin were ever mishandled — silently switch a live campaign to a new rule version."*
 *
 * TC-23 is that sentence as a test, and the way this codebase makes it true is **structural**:
 * nothing in `modules/blasts/` imports this class. There is no "should I emit?" branch to get
 * wrong, because a blast has no way to reach the publisher at all. `test/grpc/change-events.spec.ts`
 * asserts that absence by grepping the module, so adding the import later fails a test rather than
 * quietly changing behaviour on a live system. The same is true of TC-24: a draft edit never
 * reaches governance, and only the two governance transitions below publish.
 *
 * ### The stream is an optimisation, never a guarantee (§8)
 *
 * A subscriber that cannot keep up is **dropped**, not buffered indefinitely: it must reconnect and
 * re-warm through `ListActiveCampaigns`, which is the documented recovery path and is correct
 * whether or not it ever received an event. Every cache entry carries a TTL as the backstop; a
 * design where a dropped stream freezes configuration forever is one dropped connection away from
 * paying rewards on last month's rules.
 *
 * ### Why an in-process emitter and not a queue
 *
 * The portal is the only writer of campaign status, so every event originates in this process. A
 * broker would add an operational dependency to a channel whose correctness the design already
 * says must not be depended on. If the portal is ever deployed as more than one instance, each
 * instance serves the streams of the clients connected to it and the missing cross-instance fan-out
 * is exactly what the TTL covers — noted in the completion report as the one thing to revisit when
 * `APP_INSTANCE_COUNT > 1`.
 */
import { Injectable, Logger } from '@nestjs/common';
import { CHANGE_TYPE, WATCH_MAX_QUEUE, type ChangeTypeName } from './grpc.constants';

/** One emitted change. `etag` is a cheap probe, not the config itself — the client refetches. */
export interface ConfigChangeEvent {
  readonly campaignId: number;
  readonly campaignCode: string;
  readonly tenantId: number;
  readonly changeType: ChangeTypeName;
  readonly etag: string;
  readonly occurredAt: string;
}

type Listener = (event: ConfigChangeEvent) => void;

interface Subscription {
  readonly tenantId: number;
  readonly listener: Listener;
  dropped: number;
}

@Injectable()
export class ChangeEventPublisher {
  private readonly logger = new Logger(ChangeEventPublisher.name);
  private readonly subscriptions = new Set<Subscription>();

  /**
   * Subscribes to one tenant's events. Returns the unsubscribe function.
   *
   * Scope is applied by the caller (`campaign-config.service.ts` checks the grant before
   * subscribing); this class deliberately holds no authorisation logic, so there is exactly one
   * place where "may this identity watch this tenant?" is answered.
   */
  subscribe(tenantId: number, listener: Listener): () => void {
    const subscription: Subscription = { tenantId, listener, dropped: 0 };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  /** How many streams are open. Diagnostics and tests only. */
  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Publishes a governance transition.
   *
   * Never throws: a failing subscriber must not roll back the transition that produced the event.
   * The transition is already committed and audited by the time this is called — see
   * `campaigns.service.ts#pause` and `approvals.service.ts`.
   */
  publish(event: ConfigChangeEvent): void {
    for (const subscription of this.subscriptions) {
      if (subscription.tenantId !== event.tenantId) continue;
      try {
        subscription.listener(event);
      } catch (error) {
        subscription.dropped += 1;
        if (subscription.dropped >= WATCH_MAX_QUEUE) {
          this.subscriptions.delete(subscription);
          this.logger.warn(
            `dropped a WatchCampaignConfig subscriber for tenant ${subscription.tenantId} after ` +
              `${subscription.dropped} failed deliveries; it must reconnect and re-warm through ` +
              'ListActiveCampaigns',
          );
        }
        this.logger.warn(
          `failed to deliver a ${event.changeType} event for campaign ${event.campaignCode}: ` +
            `${(error as Error).message}`,
        );
      }
    }
  }

  /** Convenience for the two producers, so neither has to build the envelope by hand. */
  publishTransition(input: {
    campaignId: number;
    campaignCode: string;
    tenantId: number;
    changeType: ChangeTypeName;
    etag?: string;
  }): void {
    this.publish({
      campaignId: input.campaignId,
      campaignCode: input.campaignCode,
      tenantId: input.tenantId,
      changeType: input.changeType,
      etag: input.etag ?? '',
      occurredAt: new Date().toISOString(),
    });
  }
}

/** The wire enum number of a change type. */
export function changeTypeNumber(name: ChangeTypeName): number {
  return CHANGE_TYPE[name];
}
