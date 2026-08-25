/**
 * T-038 implementation note 5 — *"add a scheduled sweep that marks them, and also treat any read
 * of a stale row as expired, so correctness does not depend on the scheduler having run."*
 *
 * Both halves are implemented, and the order of importance is the one the note states: the
 * **read-side** rule (`isApprovalExpired`, applied by `ApprovalsService` on every read and before
 * every decision) is what makes expiry correct; this class only makes the stored column agree
 * with it, so an operator running `SELECT status FROM …` sees the same thing the checker does.
 *
 * That ordering is why this file is deliberately dull. It has no business logic, no scope, no
 * actor and no error handling beyond logging — a sweep that fails is retried an hour later and
 * nothing was wrong in the meantime. Anything more clever here would create a second, weaker
 * definition of "expired" competing with the shared one.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EXPIRY_SWEEP_CRON } from './approvals.constants';
import { APPROVAL_EXPIRY_STORE, type ApprovalExpiryStore } from './approvals.repository';

@Injectable()
export class ApprovalExpirySweeper {
  private readonly logger = new Logger(ApprovalExpirySweeper.name);

  constructor(@Inject(APPROVAL_EXPIRY_STORE) private readonly store: ApprovalExpiryStore) {}

  /**
   * Hourly. Never rejects: an unhandled rejection inside a `@Cron` handler is an unhandled
   * promise rejection at the process level, which under Node 20's default policy terminates the
   * process — an approval-queue tidy-up must not be able to take the API down.
   */
  @Cron(EXPIRY_SWEEP_CRON, { name: 'approval-expiry-sweep' })
  async sweep(): Promise<void> {
    try {
      const affected = await this.store.markExpired();
      if (affected > 0) {
        this.logger.log(`Approval expiry sweep marked ${String(affected)} request(s) expired.`);
      }
    } catch (error) {
      this.logger.error(
        'Approval expiry sweep failed. Requests past their deadline are still refused on read ' +
          `and before every decision, so no request became actionable. Cause: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
