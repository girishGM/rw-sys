/**
 * T-RR-036. Placeholder counter for `notification_logged_total`
 * (`07-CONFIGURABILITY-AND-OBSERVABILITY.md` §3, no labels) — the identical in-memory,
 * injectable-and-testable placeholder precedent `DispatchMetricsService` (T-RR-034,
 * `src/modules/dispatch/dispatch-metrics.service.ts`, confirmed by direct read) already
 * established for this project: this service's own real `MetricsRegistry`
 * (`src/observability/`) doesn't exist yet — that's `T-RR-040`'s own file scope (Wave 4,
 * `agent-rr-qa`), which depends on this task and audits that every named metric in §3 increments
 * at its real call site. Building this placeholder now, under the exact metric name/label contract
 * §3 already fixes, means that audit finds a real call site to adopt rather than a gap to file a
 * defect against.
 */
import { Injectable } from '@nestjs/common';

@Injectable()
export class NotificationMetricsService {
  private count = 0;

  /** Increment `notification_logged_total` — call only once per `notification_log` row actually
   * written (implementation note 6), never on a skip. */
  incrementNotificationLogged(): void {
    this.count += 1;
  }

  /** Test/observability accessor — the current count, `0` if never incremented. */
  getNotificationLoggedCount(): number {
    return this.count;
  }
}
